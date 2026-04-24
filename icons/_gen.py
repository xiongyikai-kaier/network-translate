"""Generate icons for the extension (circular, purple→pink gradient, bilingual 文/A)."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.dirname(os.path.abspath(__file__))

C_TOP = (124, 58, 237, 255)    # #7C3AED violet
C_BOT = (236, 72, 153, 255)    # #EC4899 pink


def _gradient_circle(size: int) -> Image.Image:
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(C_TOP[0] * (1 - t) + C_BOT[0] * t)
        g = int(C_TOP[1] * (1 - t) + C_BOT[1] * t)
        b = int(C_TOP[2] * (1 - t) + C_BOT[2] * t)
        for x in range(size):
            grad.putpixel((x, y), (r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([(0, 0), (size - 1, size - 1)], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def _load_font(px: int) -> ImageFont.FreeTypeFont:
    for cand in [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]:
        if os.path.exists(cand):
            try:
                return ImageFont.truetype(cand, px)
            except Exception:
                pass
    return ImageFont.load_default()


def _draw_text_centered(img, text, font, cx, cy, fill=(255, 255, 255, 255)):
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = cx - tw / 2 - bbox[0]
    y = cy - th / 2 - bbox[1]
    d.text((x, y), text, font=font, fill=fill)


def make(size: int) -> Image.Image:
    img = _gradient_circle(size)
    if size <= 20:
        font = _load_font(int(size * 0.70))
        _draw_text_centered(img, "译", font, size / 2, size / 2 - size * 0.02)
    else:
        f_cn = _load_font(int(size * 0.44))
        f_en = _load_font(int(size * 0.40))
        _draw_text_centered(img, "文", f_cn, size * 0.36, size * 0.38)
        _draw_text_centered(img, "A", f_en, size * 0.66, size * 0.66)
        d = ImageDraw.Draw(img)
        lw = max(1, size // 32)
        d.line(
            [(size * 0.44, size * 0.56), (size * 0.58, size * 0.48)],
            fill=(255, 255, 255, 220), width=lw,
        )
    return img


if __name__ == "__main__":
    for s in (16, 48, 128):
        make(s).save(os.path.join(OUT, f"icon{s}.png"))
    print("ok")
