from PIL import Image, ImageDraw, ImageFilter
import math

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# Rounded-square background with a vertical gradient.
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
for y in range(S):
    t = y / (S - 1)
    r = int(9 + 8 * t)
    g = int(16 + 14 * t)
    b = int(30 + 26 * t)
    bd.line([(0, y), (S, y)], fill=(r, g, b, 255))
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle((48, 48, S - 48, S - 48), radius=224, fill=255)
img.alpha_composite(Image.composite(bg, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))

# Soft cyan glow behind the orb.
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((250, 250, S - 250, S - 250), fill=(14, 165, 233, 90))
gd.ellipse((330, 330, S - 330, S - 330), fill=(56, 189, 248, 110))
glow = glow.filter(ImageFilter.GaussianBlur(54))
img.alpha_composite(glow)

# Orbital rings.
d = ImageDraw.Draw(img)
d.ellipse((214, 214, S - 214, S - 214), outline=(56, 189, 248, 235), width=22)
d.ellipse((260, 260, S - 260, S - 260), outline=(125, 211, 252, 120), width=7)

# Central orb with a simple radial highlight.
orb = Image.new("RGBA", (S, S), (0, 0, 0, 0))
od = ImageDraw.Draw(orb)
od.ellipse((360, 360, S - 360, S - 360), fill=(2, 132, 199, 255))
od.ellipse((378, 378, S - 378, S - 378), fill=(14, 165, 233, 255))
od.ellipse((398, 398, S - 398, S - 398), fill=(56, 189, 248, 255))
od.ellipse((426, 426, S - 426, S - 426), fill=(125, 211, 252, 255))
od.ellipse((452, 452, S - 500, S - 500), fill=(224, 242, 254, 210))
img.alpha_composite(orb)

# A small satellite on the ring.
sat = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(sat)
sd.ellipse((720, 166, 796, 242), fill=(240, 249, 255, 255))
sat = sat.filter(ImageFilter.GaussianBlur(1))
img.alpha_composite(sat)
d.ellipse((738, 184, 778, 224), fill=(224, 242, 254, 255))

# Save a 256 px PNG and a multi-size Windows icon.
img = img.resize((512, 512), Image.LANCZOS)
img.save("assets/orb.png")
img.resize((256, 256), Image.LANCZOS).save(
    "assets/orb.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote assets/orb.png and assets/orb.ico")
