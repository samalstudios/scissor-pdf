//! Drawing on top of existing pages: page numbers and image watermarks.

use lopdf::content::{Content, Operation};
use lopdf::{Object, dictionary};

use crate::Res;
use crate::images::rgba_xobject;
use crate::ops::{finish, load};
use crate::pages::{PageGeom, add_resource, overlay_content, page_ids};

/// Helvetica advance widths for ASCII 32..=126, per 1000 units of font size.
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584,
];

fn text_width(text: &[u8], size: f32) -> f32 {
    text.iter().map(|b| HELVETICA.get(b.wrapping_sub(32) as usize).copied().unwrap_or(556) as f32).sum::<f32>() * size
        / 1000.0
}

/// WinAnsiEncoding matches Latin-1 for printable characters, so accented Latin text
/// (Página, Seite, Sayfa) survives; anything else becomes '?'.
fn win_ansi(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| match c as u32 {
            0x20..=0x7E | 0xA0..=0xFF => c as u32 as u8,
            _ => b'?',
        })
        .collect()
}

fn cm(m: [f32; 6]) -> Operation {
    Operation::new("cm", m.iter().map(|v| Object::Real(*v)).collect())
}

pub struct NumberOptions<'a> {
    /// One of top-left, top-center, top-right, bottom-left, bottom-center, bottom-right.
    pub position: &'a str,
    /// Text with `{n}` for the page number and `{total}` for the count.
    pub template: &'a str,
    pub start: u32,
    pub first_page: u32,
    pub size: f32,
    pub margin: f32,
}

pub fn page_numbers(bytes: &[u8], o: &NumberOptions) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    crate::pages::bake_inherited(&mut doc);
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
    });
    let ids = page_ids(&doc);
    let first = o.first_page.max(1) as usize;
    let numbered = ids.len().saturating_sub(first - 1) as u32;
    let total = o.start + numbered.saturating_sub(1);
    for (i, id) in ids.iter().enumerate().skip(first - 1) {
        let n = o.start + (i + 1 - first) as u32;
        let text = win_ansi(&o.template.replace("{n}", &n.to_string()).replace("{total}", &total.to_string()));
        let geom = PageGeom::of(&doc, *id);
        let (vw, vh) = geom.visual();
        let tw = text_width(&text, o.size);
        let vx = if o.position.ends_with("left") {
            o.margin
        } else if o.position.ends_with("right") {
            vw - o.margin - tw
        } else {
            (vw - tw) / 2.0
        };
        let vy = if o.position.starts_with("top") { vh - o.margin - o.size * 0.72 } else { o.margin };
        let ops = vec![
            Operation::new("q", vec![]),
            cm(geom.place(vx, vy)),
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["SPNum".into(), Object::Real(o.size)]),
            Operation::new("rg", vec![Object::Real(0.2), Object::Real(0.2), Object::Real(0.2)]),
            Operation::new("Td", vec![0.into(), 0.into()]),
            Operation::new("Tj", vec![Object::String(text, lopdf::StringFormat::Literal)]),
            Operation::new("ET", vec![]),
            Operation::new("Q", vec![]),
        ];
        add_resource(&mut doc, *id, b"Font", b"SPNum", font)?;
        overlay_content(&mut doc, *id, Content { operations: ops }.encode().map_err(|e| e.to_string())?)?;
    }
    finish(doc, false)
}

pub struct WatermarkOptions {
    /// Width of the mark as a fraction of the page width.
    pub scale: f32,
    /// Counter-clockwise, in degrees.
    pub rotation: f32,
    pub opacity: f32,
    pub tiled: bool,
}

pub fn watermark(bytes: &[u8], rgba: &[u8], iw: u32, ih: u32, o: &WatermarkOptions) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    crate::pages::bake_inherited(&mut doc);
    let image = rgba_xobject(&mut doc, rgba, iw, ih)?;
    let gs = doc.add_object(dictionary! { "Type" => "ExtGState", "ca" => o.opacity, "CA" => o.opacity });
    let (sin, cos) = o.rotation.to_radians().sin_cos();
    for id in page_ids(&doc) {
        let geom = PageGeom::of(&doc, id);
        let (vw, vh) = geom.visual();
        let dw = vw * o.scale;
        let dh = dw * ih as f32 / iw.max(1) as f32;
        let centers: Vec<(f32, f32)> = if o.tiled {
            let step_x = dw * 1.6;
            let step_y = (dh * 3.0).max(dw * 0.6);
            let mut v = Vec::new();
            let mut row = 0;
            let mut y = step_y / 2.0;
            while y < vh + step_y {
                let offset = if row % 2 == 1 { step_x / 2.0 } else { 0.0 };
                let mut x = offset;
                while x < vw + step_x {
                    v.push((x, y));
                    x += step_x;
                }
                y += step_y;
                row += 1;
            }
            v
        } else {
            vec![(vw / 2.0, vh / 2.0)]
        };
        let mut ops = vec![Operation::new("q", vec![]), cm(geom.place(0.0, 0.0)), Operation::new("gs", vec!["SPGs".into()])];
        for (cx, cy) in centers {
            ops.push(Operation::new("q", vec![]));
            ops.push(cm([1.0, 0.0, 0.0, 1.0, cx, cy]));
            ops.push(cm([cos, sin, -sin, cos, 0.0, 0.0]));
            ops.push(cm([dw, 0.0, 0.0, dh, -dw / 2.0, -dh / 2.0]));
            ops.push(Operation::new("Do", vec!["SPWm".into()]));
            ops.push(Operation::new("Q", vec![]));
        }
        ops.push(Operation::new("Q", vec![]));
        add_resource(&mut doc, id, b"XObject", b"SPWm", image)?;
        add_resource(&mut doc, id, b"ExtGState", b"SPGs", gs)?;
        overlay_content(&mut doc, id, Content { operations: ops }.encode().map_err(|e| e.to_string())?)?;
    }
    finish(doc, false)
}
