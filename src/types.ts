/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type DrawingTool = 
  | 'pen' 
  | 'straightLine' 
  | 'disappearingInk' 
  | 'eraser' 
  | 'pointer' 
  | 'rectangle' 
  | 'ellipse' 
  | 'arrow' 
  | 'triangle' 
  | 'text' 
  | 'magnifier';

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  points: Point[];
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  isDisappearing?: boolean;
  createdAt: number;
  text?: string;
  fontSize?: number;
}
