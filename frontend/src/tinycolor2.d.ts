declare module "tinycolor2" {
  interface TinyColor {
    isValid(): boolean;
    toHsl(): { h: number; s: number; l: number; a: number };
    toHexString(): string;
    toRgbString(): string;
  }
  export default function tinycolor(color: string | { h: number; s: number; l: number; a?: number }): TinyColor;
}
