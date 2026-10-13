//! Building PDFs from images. JPEGs are embedded byte for byte (no quality loss);
//! everything else arrives as RGBA pixels decoded by the browser.

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

use crate::Res;

struct Jpeg {
    width: u32,
    height: u32,
    components: u8,
    adobe: bool,
    orientation: u8,
}

fn parse_jpeg(data: &[u8]) -> Option<Jpeg> {
    if data.get(0..2)? != [0xFF, 0xD8] {
        return None;
    }
    let (mut adobe, mut orientation) = (false, 1);
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        let seg = data.get(i + 4..i + 2 + len)?;
        match marker {
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                return Some(Jpeg {
                    height: u16::from_be_bytes([seg[1], seg[2]]) as u32,
                    width: u16::from_be_bytes([seg[3], seg[4]]) as u32,
                    components: seg[5],
                    adobe,
                    orientation,
                });
            }
            0xEE if seg.starts_with(b"Adobe") => adobe = true,
            0xE1 if seg.starts_with(b"Exif\0\0") => orientation = exif_orientation(&seg[6..]).unwrap_or(1),
            0xDA => return None,
            _ => {}
        }
        i += 2 + len;
    }
    None
}

fn exif_orientation(tiff: &[u8]) -> Option<u8> {
    let le = match tiff.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |o: usize| -> Option<u16> {
        let b = [*tiff.get(o)?, *tiff.get(o + 1)?];
        Some(if le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    };
    let u32_at = |o: usize| -> Option<u32> {
        let b = [*tiff.get(o)?, *tiff.get(o + 1)?, *tiff.get(o + 2)?, *tiff.get(o + 3)?];
        Some(if le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    };
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    for n in 0..count {
        let entry = ifd + 2 + n * 12;
        if u16_at(entry)? == 0x0112 {
            let v = u16_at(entry + 8)? as u8;
            return (1..=8).contains(&v).then_some(v);
        }
    }
    None
}

/// Maps the stored image's unit square onto the upright one for an EXIF orientation.
fn orientation_matrix(o: u8) -> [f32; 6] {
    match o {
        2 => [-1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
        3 => [-1.0, 0.0, 0.0, -1.0, 1.0, 1.0],
        4 => [1.0, 0.0, 0.0, -1.0, 0.0, 1.0],
        5 => [0.0, -1.0, -1.0, 0.0, 1.0, 1.0],
        6 => [0.0, -1.0, 1.0, 0.0, 0.0, 1.0],
        7 => [0.0, 1.0, 1.0, 0.0, 0.0, 0.0],
        8 => [0.0, 1.0, -1.0, 0.0, 1.0, 0.0],
        _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    }
}

/// Adds an RGBA image as an XObject, with a soft mask only when it has transparency.
pub fn rgba_xobject(doc: &mut Document, rgba: &[u8], w: u32, h: u32) -> Res<ObjectId> {
    let n = w as usize * h as usize;
    if rgba.len() < n * 4 || n == 0 {
        return Err("INVALID: image data is incomplete".into());
    }
    let mut rgb = Vec::with_capacity(n * 3);
    let mut alpha = Vec::with_capacity(n);
    for px in rgba[..n * 4].chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
        alpha.push(px[3]);
    }
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
        "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    };
    if alpha.iter().any(|a| *a != 255) {
        let mut mask = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            },
            alpha,
        );
        mask.compress().map_err(|e| e.to_string())?;
        dict.set("SMask", doc.add_object(mask));
    }
    let mut stream = Stream::new(dict, rgb);
    stream.compress().map_err(|e| e.to_string())?;
    Ok(doc.add_object(stream))
}

/// Page layout: `fit` sizes each page to its image, `a4` and `letter` centre it on paper.
pub struct ImagesToPdf {
    doc: Document,
    pages_id: ObjectId,
    kids: Vec<ObjectId>,
    paper: Option<(f32, f32)>,
    margin: f32,
}

impl ImagesToPdf {
    pub fn new(paper: &str, margin: f32) -> ImagesToPdf {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let paper = match paper {
            "a4" => Some((595.28, 841.89)),
            "letter" => Some((612.0, 792.0)),
            _ => None,
        };
        ImagesToPdf { doc, pages_id, kids: Vec::new(), paper, margin }
    }

    pub fn add_jpeg(&mut self, data: &[u8]) -> Res<()> {
        let info = parse_jpeg(data).ok_or("INVALID: could not read this JPEG")?;
        let mut dict = dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => info.width as i64, "Height" => info.height as i64,
            "BitsPerComponent" => 8, "Filter" => "DCTDecode",
        };
        match info.components {
            1 => dict.set("ColorSpace", "DeviceGray"),
            3 => dict.set("ColorSpace", "DeviceRGB"),
            4 => {
                dict.set("ColorSpace", "DeviceCMYK");
                if info.adobe {
                    dict.set("Decode", (0..8).map(|i| Object::Integer(1 - i % 2)).collect::<Vec<_>>());
                }
            }
            _ => return Err("INVALID: unsupported JPEG colour format".into()),
        }
        let id = self.doc.add_object(Stream::new(dict, data.to_vec()).with_compression(false));
        let (w, h) = if info.orientation >= 5 { (info.height, info.width) } else { (info.width, info.height) };
        self.add_page(id, w, h, orientation_matrix(info.orientation));
        Ok(())
    }

    pub fn add_rgba(&mut self, rgba: &[u8], w: u32, h: u32) -> Res<()> {
        let id = rgba_xobject(&mut self.doc, rgba, w, h)?;
        self.add_page(id, w, h, orientation_matrix(1));
        Ok(())
    }

    fn add_page(&mut self, image: ObjectId, w: u32, h: u32, orient: [f32; 6]) {
        let (w, h) = (w as f32, h as f32);
        let (pw, ph) = match self.paper {
            Some((a, b)) if w > h => (b, a),
            Some(p) => p,
            None => {
                let s = 842.0 / w.max(h);
                (w * s + self.margin * 2.0, h * s + self.margin * 2.0)
            }
        };
        let (aw, ah) = (pw - self.margin * 2.0, ph - self.margin * 2.0);
        let s = (aw / w).min(ah / h);
        let (dw, dh) = (w * s, h * s);
        let (x, y) = ((pw - dw) / 2.0, (ph - dh) / 2.0);
        let real = |v: f32| Object::Real(v);
        let ops = vec![
            Operation::new("q", vec![]),
            Operation::new("cm", vec![real(dw), real(0.0), real(0.0), real(dh), real(x), real(y)]),
            Operation::new("cm", orient.iter().map(|v| real(*v)).collect()),
            Operation::new("Do", vec!["Im0".into()]),
            Operation::new("Q", vec![]),
        ];
        let content = self.doc.add_object(Stream::new(Dictionary::new(), Content { operations: ops }.encode().unwrap_or_default()));
        let page = self.doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => self.pages_id,
            "MediaBox" => vec![0.into(), 0.into(), real(pw), real(ph)],
            "Contents" => content,
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
        });
        self.kids.push(page);
    }

    pub fn finish(mut self) -> Res<Vec<u8>> {
        if self.kids.is_empty() {
            return Err("INVALID: add at least one image".into());
        }
        let count = self.kids.len() as i64;
        let kids: Vec<Object> = self.kids.iter().map(|id| Object::Reference(*id)).collect();
        self.doc.objects.insert(self.pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
        let catalog = self.doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages_id });
        self.doc.trailer.set("Root", catalog);
        self.doc.compress();
        crate::ops::finish(self.doc, false)
    }
}
