declare module 'qrcode' {
  export function toString(text: string, options?: {
    type?: 'svg' | 'utf8' | 'terminal';
    margin?: number;
    width?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  }): Promise<string>;
}
