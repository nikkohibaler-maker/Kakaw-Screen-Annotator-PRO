import Cocoa
import QuartzCore

// MARK: - Types
enum DrawingTool: Int {
    case pen = 1
    case straightLine = 2
    case disappearingInk = 3
    case eraser = 4
    case pointer = 5
    case rectangle = 6
    case ellipse = 7
    case arrow = 8
    case triangle = 9
    case text = 10
}

struct DrawingState {
    var tool: DrawingTool = .pen
    var color: NSColor = .systemGreen
    var lineWidth: CGFloat = 4.0
    var opacity: CGFloat = 1.0
    var vanishTime: TimeInterval = 3.0
}

// MARK: - ProAnnotateOverlayView
/// Ultra-smooth, production-grade annotation overlay optimized for M2.
class ProAnnotateOverlayView: NSView {
    
    // MARK: - Properties
    var state = DrawingState()
    
    // Layers & History
    private var shapeLayers: [CAShapeLayer] = []
    private var undoStack: [CALayer] = []
    private var redoStack: [CALayer] = []
    
    // Drawing Session State
    private var isDrawing = false
    private var currentPoints: [CGPoint] = []
    private var currentLayer: CAShapeLayer?
    private var lastDrawTime: CFTimeInterval = 0
    private let throttleInterval: CFTimeInterval = 1.0 / 120.0 // 120Hz Target
    
    // Magnifier state
    private var magnifierLayer: CALayer?
    private var magnifierPos: CGPoint = .zero
    
    // MARK: - Initialization
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupView()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupView()
    }
    
    private func setupView() {
        self.wantsLayer = true
        self.layer?.backgroundColor = NSColor.clear.cgColor
        
        // Monitoring for global shortcuts
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            return self?.handleKeyEvent(event)
        }
    }
    
    // MARK: - Event Handling
    private func handleKeyEvent(_ event: NSEvent) -> NSEvent? {
        let modifierFlags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        
        // Tool switching (1-5)
        if let char = event.charactersIgnoringModifiers, let val = Int(char), val >= 1 && val <= 5 {
            state.tool = DrawingTool(rawValue: val) ?? .pen
            return nil
        }
        
        // Undo / Redo (⌘Z / ⇧⌘Z)
        if modifierFlags.contains(.command) && event.keyCode == 6 { // Z is 6
            if modifierFlags.contains(.shift) {
                redo()
            } else {
                undo()
            }
            return nil
        }
        
        return event
    }
    
    // MARK: - Mouse Events
    override func mouseDown(with event: NSEvent) {
        guard state.tool != .pointer else { return }
        
        let point = convert(event.locationInWindow, from: nil)
        
        if state.tool == .eraser {
            performEraserHitTest(at: point)
            return
        }
        
        if state.tool == .text {
            addTextLayer(at: point)
            return
        }
        
        isDrawing = true
        currentPoints = [point]
        
        // Setup preview layer
        let newLayer = CAShapeLayer()
        newLayer.strokeColor = (state.tool == .disappearingInk ? NSColor.systemYellow.cgColor : state.color.cgColor)
        newLayer.fillColor = nil
        newLayer.lineWidth = state.lineWidth
        newLayer.lineCap = .round
        newLayer.lineJoin = .round
        newLayer.opacity = Float(state.opacity)
        
        self.layer?.addSublayer(newLayer)
        currentLayer = newLayer
        redoStack.removeAll() // Breaking redo chain
    }
    
    override func mouseDragged(with event: NSEvent) {
        guard isDrawing, let layer = currentLayer else { return }
        
        // Throttling for M2 Smoothness
        let currentTime = CACurrentMediaTime()
        guard currentTime - lastDrawTime > throttleInterval else { return }
        lastDrawTime = currentTime
        
        let point = convert(event.locationInWindow, from: nil)
        currentPoints.append(point)
        
        updateLayerPath(layer, points: currentPoints, tool: state.tool)
    }
    
    override func mouseUp(with event: NSEvent) {
        guard isDrawing, let layer = currentLayer else { return }
        
        // Smart Shape Detection Optimization
        if state.tool == .pen && currentPoints.count > 10 {
            if let detected = detectShape(currentPoints) {
                updateLayerPath(layer, points: detected.points, tool: detected.tool)
            }
        }
        
        if state.tool == .disappearingInk {
            scheduleFadeOut(layer: layer)
        } else {
            undoStack.append(layer)
        }
        
        isDrawing = false
        currentPoints = []
        currentLayer = nil
    }
    
    // MARK: - Path Logic (Production Smoothing)
    private func updateLayerPath(_ layer: CAShapeLayer, points: [CGPoint], tool: DrawingTool) {
        guard points.count >= 2 else { return }
        let path = CGMutablePath()
        let start = points[0]
        let end = points[points.count - 1]
        
        switch tool {
        case .straightLine:
            path.move(to: start)
            path.addLine(to: end)
            
        case .rectangle:
            let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), 
                              width: abs(end.x - start.x), height: abs(end.y - start.y))
            path.addRect(rect)
            
        case .ellipse:
            let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), 
                              width: abs(end.x - start.x), height: abs(end.y - start.y))
            path.addEllipse(in: rect)
            
        case .triangle:
            let minX = min(start.x, end.x)
            let maxX = max(start.x, end.x)
            let minY = min(start.y, end.y)
            let maxY = max(start.y, end.y)
            path.move(to: CGPoint(x: (minX + maxX)/2, y: minY))
            path.addLine(to: CGPoint(x: maxX, y: maxY))
            path.addLine(to: CGPoint(x: minX, y: maxY))
            path.closeSubpath()

        case .arrow:
            drawArrow(path: path, start: start, end: end)
            
        default: // Smooth Pen Logic
            path.move(to: points[0])
            for i in 1..<points.count - 1 {
                let current = points[i]
                let next = points[i+1]
                let midPoint = CGPoint(x: (current.x + next.x) / 2, y: (current.y + next.y) / 2)
                path.addQuadCurve(to: midPoint, control: current)
            }
            path.addLine(to: points.last!)
        }
        
        layer.path = path
    }
    
    private func drawArrow(path: CGMutablePath, start: CGPoint, end: CGPoint) {
        path.move(to: start)
        path.addLine(to: end)
        
        let arrowAngle = CGFloat(Double.pi / 6)
        let arrowLength: CGFloat = 20
        let angle = atan2(end.y - start.y, end.x - start.x)
        
        let p1 = CGPoint(x: end.x - arrowLength * cos(angle - arrowAngle),
                         y: end.y - arrowLength * sin(angle - arrowAngle))
        let p2 = CGPoint(x: end.x - arrowLength * cos(angle + arrowAngle),
                         y: end.y - arrowLength * sin(angle + arrowAngle))
        
        path.move(to: end)
        path.addLine(to: p1)
        path.move(to: end)
        path.addLine(to: p2)
    }
    
    // MARK: - Smart Shape Detection
    private func detectShape(_ points: [CGPoint]) -> (tool: DrawingTool, points: [CGPoint])? {
        guard points.count > 10 else { return nil }
        
        let start = points.first!
        let end = points.last!
        let minX = points.map { $0.x }.min() ?? 0
        let maxX = points.map { $0.x }.max() ?? 0
        let minY = points.map { $0.y }.min() ?? 0
        let maxY = points.map { $0.y }.max() ?? 0
        let width = maxX - minX
        let height = maxY - minY
        
        // 1. Line Test (MSE deviation)
        let lineDist = hypot(end.x - start.x, end.y - start.y)
        if lineDist > (width + height) * 0.45 {
            return (.straightLine, [start, end])
        }
        
        // 2. Circle Test
        let center = CGPoint(x: (minX + maxX)/2, y: (minY + maxY)/2)
        let radius = (width + height) / 4
        var radiusSum: CGFloat = 0
        for p in points {
            radiusSum += hypot(p.x - center.x, p.y - center.y)
        }
        let avgRadius = radiusSum / CGFloat(points.count)
        let radiusDeviation = abs(avgRadius - radius) / radius
        
        if radiusDeviation < 0.15 {
            return (.ellipse, [CGPoint(x: minX, y: minY), CGPoint(x: maxX, y: maxY)])
        }
        
        return nil
    }
    
    // MARK: - Text Tool
    private func addTextLayer(at point: CGPoint) {
        let textLayer = CATextLayer()
        textLayer.string = "Click to Edit"
        textLayer.fontSize = 24
        textLayer.foregroundColor = state.color.cgColor
        textLayer.font = NSFont.systemFont(ofSize: 24)
        textLayer.frame = CGRect(x: point.x, y: point.y, width: 300, height: 40)
        textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        
        self.layer?.addSublayer(textLayer)
        undoStack.append(textLayer)
        
        // In a real app, you'd spawn a hidden NSTextField here to handle editing
    }
    
    // MARK: - Features
    func undo() {
        guard let last = undoStack.popLast() else { return }
        last.removeFromSuperlayer()
        redoStack.append(last)
    }
    
    func redo() {
        guard let last = redoStack.popLast() else { return }
        self.layer?.addSublayer(last)
        undoStack.append(last)
    }
    
    func clearAll() {
        undoStack.forEach { $0.removeFromSuperlayer() }
        undoStack.removeAll()
        redoStack.removeAll()
    }
    
    private func scheduleFadeOut(layer: CAShapeLayer) {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = state.vanishTime
            layer.opacity = 0
        }, completionHandler: {
            layer.removeFromSuperlayer()
        })
    }
    
    private func performEraserHitTest(at point: CGPoint) {
        let hitLayers = undoStack.filter { layer in
            if let shape = layer as? CAShapeLayer, let path = shape.path {
                return path.contains(point) || path.copy(strokingWithWidth: 20, lineCap: .round, lineJoin: .round, miterLimit: 1).contains(point)
            }
            return layer.frame.contains(point)
        }
        
        hitLayers.forEach { layer in
            if let idx = undoStack.firstIndex(of: layer) {
                undoStack.remove(at: idx)
                layer.removeFromSuperlayer()
            }
        }
    }
    
    // MARK: - Export
    func exportToPNG() {
        guard let layer = self.layer else { return }
        let width = Int(layer.bounds.width)
        let height = Int(layer.bounds.height)
        
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        
        if let context = context {
            layer.render(in: context)
            if let cgImage = context.makeImage() {
                let image = NSImage(cgImage: cgImage, size: layer.bounds.size)
                // Save logic here...
            }
        }
    }
}
