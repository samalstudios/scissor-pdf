//! Lossless clean-up plus optional JPEG re-encoding and downsampling of large images.

use std::collections::BTreeSet;
use std::io::Cursor;

use image::{DynamicImage, GrayImage, ImageFormat, RgbImage, codecs::jpeg::JpegEncoder, imageops::FilterType};
use lopdf::{Document, Object, ObjectId};

use crate::Res;
use crate::ops::{finish, load};

struct Level {
    /// Longest side in pixels an image may keep; `None` leaves images alone.
    max_side: Option<u32>,
    quality: u8,
    strip_metadata: bool,
}

fn level(n: u8) -> Level {
    match n {
        0 => Level { max_side: None, quality: 0, strip_metadata: false },
        2 => Level { max_side: Some(1400), quality: 50, strip_metadata: true },
        _ => Level { max_side: Some(2200), quality: 72, strip_metadata: false },
    }
}

/// Level 0 is lossless, 1 is recommended, 2 is strongest.
pub fn compress(bytes: &[u8], level_index: u8) -> Res<Vec<u8>> {
    let lvl = level(level_index);
    let mut doc = load(bytes)?;

    for id in doc.page_iter().collect::<Vec<_>>() {
        if let Ok(page) = doc.get_dictionary_mut(id) {
            page.remove(b"Thumb");
            page.remove(b"PieceInfo");
        }
    }
    if let Ok(catalog) = doc.catalog_mut() {
        catalog.remove(b"PieceInfo");
        if lvl.strip_metadata {
            catalog.remove(b"Metadata");
        }
    }

    if lvl.max_side.is_some() {
        let masks = mask_ids(&doc);
        let images: Vec<ObjectId> = doc
            .objects
            .iter()
            .filter(|(id, o)| {
                !masks.contains(id)
                    && o.as_stream().map(|s| s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")).unwrap_or(false)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in images {
            if let Some((content, w, h)) = recompress(&doc, id, &lvl)
                && let Ok(Object::Stream(stream)) = doc.get_object_mut(id)
            {
                stream.dict.set("Filter", "DCTDecode");
                stream.dict.remove(b"DecodeParms");
                stream.dict.set("Width", w as i64);
                stream.dict.set("Height", h as i64);
                stream.dict.set("BitsPerComponent", 8);
                stream.set_content(content);
                stream.allows_compression = false;
            }
        }
    }

    doc.compress();
    finish(doc, true)
}

/// Images used as soft masks keep their exact values.
fn mask_ids(doc: &Document) -> BTreeSet<ObjectId> {
    doc.objects
        .values()
        .filter_map(|o| o.as_stream().ok())
        .filter_map(|s| s.dict.get(b"SMask").and_then(Object::as_reference).ok())
        .collect()
}

fn components(doc: &Document, cs: Option<&Object>) -> Option<u8> {
    let cs = match cs? {
        Object::Reference(r) => doc.get_object(*r).ok()?,
        o => o,
    };
    match cs {
        Object::Name(n) if n == b"DeviceRGB" => Some(3),
        Object::Name(n) if n == b"DeviceGray" => Some(1),
        Object::Array(a) if a.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => {
            let stream = doc.get_object(a.get(1)?.as_reference().ok()?).ok()?.as_stream().ok()?;
            match stream.dict.get(b"N").and_then(Object::as_i64).ok()? {
                1 => Some(1),
                3 => Some(3),
                _ => None,
            }
        }
        _ => None,
    }
}

fn recompress(doc: &Document, id: ObjectId, lvl: &Level) -> Option<(Vec<u8>, u32, u32)> {
    let stream = doc.get_object(id).ok()?.as_stream().ok()?;
    let d = &stream.dict;
    if d.has(b"Decode") || d.get(b"ImageMask").and_then(Object::as_bool).unwrap_or(false) {
        return None;
    }
    if matches!(d.get(b"Mask"), Ok(Object::Array(_))) {
        return None; // colour-key masks break under lossy compression
    }
    let comps = components(doc, d.get(b"ColorSpace").ok())?;
    let w = d.get(b"Width").and_then(Object::as_i64).ok()? as u32;
    let h = d.get(b"Height").and_then(Object::as_i64).ok()? as u32;
    if w < 16 || h < 16 {
        return None;
    }
    let filters: Vec<Vec<u8>> = match d.get(b"Filter") {
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_name().ok().map(<[u8]>::to_vec)).collect(),
        _ => vec![],
    };
    let original_len = stream.content.len();
    let img = if filters == [b"DCTDecode".to_vec()] {
        let decoded = image::load_from_memory_with_format(&stream.content, ImageFormat::Jpeg).ok()?;
        match (comps, decoded) {
            (3, i @ DynamicImage::ImageRgb8(_)) => i,
            (1, i @ DynamicImage::ImageLuma8(_)) => i,
            _ => return None,
        }
    } else if filters.iter().all(|f| f == b"FlateDecode") && d.get(b"BitsPerComponent").and_then(Object::as_i64).ok()? == 8 {
        let raw = stream.decompressed_content_with_limit(w as usize * h as usize * comps as usize + 1).ok()?;
        if raw.len() < w as usize * h as usize * comps as usize {
            return None;
        }
        let raw = raw[..w as usize * h as usize * comps as usize].to_vec();
        if comps == 3 { DynamicImage::ImageRgb8(RgbImage::from_raw(w, h, raw)?) } else { DynamicImage::ImageLuma8(GrayImage::from_raw(w, h, raw)?) }
    } else {
        return None;
    };

    let max_side = lvl.max_side?;
    let img = if w.max(h) > max_side {
        let scale = max_side as f32 / w.max(h) as f32;
        let (nw, nh) = (((w as f32 * scale).round() as u32).max(1), ((h as f32 * scale).round() as u32).max(1));
        img.resize_exact(nw, nh, FilterType::Triangle)
    } else {
        img
    };
    let mut out = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut out, lvl.quality).encode_image(&img).ok()?;
    let out = out.into_inner();
    // Keep the original unless the new version is clearly smaller.
    (out.len() * 10 < original_len * 9).then(|| (out, img.width(), img.height()))
}
