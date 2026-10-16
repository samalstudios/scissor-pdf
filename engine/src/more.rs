//! Second set of operations: colour, annotations, images, page layout, splitting and inspection.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use image::{DynamicImage, GrayImage, ImageFormat, RgbImage, codecs::jpeg::JpegEncoder};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

use crate::Res;
use crate::ops::{finish, load, merge, organize, page_count};
use crate::pages::{PageGeom, bake_inherited, page_ids, set_page_list};
use crate::zip::ZipWriter;

fn real(v: f32) -> Object {
    Object::Real(v)
}

fn e(err: lopdf::Error) -> String {
    err.to_string()
}

fn resolve<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
    match obj {
        Object::Reference(r) => doc.get_object(*r).unwrap_or(obj),
        o => o,
    }
}

fn num(o: &Object) -> Option<f32> {
    o.as_float().ok()
}

/* ---------- Grayscale ---------- */

fn luma(r: f32, g: f32, b: f32) -> f32 {
    (0.299 * r + 0.587 * g + 0.114 * b).clamp(0.0, 1.0)
}

fn cmyk_luma(c: f32, m: f32, y: f32, k: f32) -> f32 {
    luma((1.0 - c) * (1.0 - k), (1.0 - m) * (1.0 - k), (1.0 - y) * (1.0 - k))
}

/// Number of components of a colour space operand, when it is one we can turn grey.
fn convertible_space(doc: &Document, resources: Option<&Dictionary>, name: &[u8]) -> Option<u8> {
    match name {
        b"DeviceRGB" | b"RGB" | b"CalRGB" => return Some(3),
        b"DeviceCMYK" | b"CMYK" => return Some(4),
        _ => {}
    }
    let cs = resources?.get(b"ColorSpace").ok().map(|o| resolve(doc, o))?.as_dict().ok()?.get(name).ok()?;
    match resolve(doc, cs) {
        Object::Name(n) if n == b"DeviceRGB" => Some(3),
        Object::Name(n) if n == b"DeviceCMYK" => Some(4),
        Object::Array(a) => match a.first()?.as_name().ok()? {
            b"ICCBased" => match resolve(doc, a.get(1)?).as_stream().ok()?.dict.get(b"N").ok()?.as_i64().ok()? {
                3 => Some(3),
                4 => Some(4),
                _ => None,
            },
            b"CalRGB" => Some(3),
            _ => None,
        },
        _ => None,
    }
}

fn gray_ops(doc: &Document, resources: Option<&Dictionary>, ops: Vec<Operation>) -> Vec<Operation> {
    // Whether the current fill / stroke colour space is one we converted to DeviceGray.
    let (mut fill, mut stroke) = (0u8, 0u8);
    let mut stack: Vec<(u8, u8)> = Vec::new();
    let nums = |ops: &[Object]| -> Option<Vec<f32>> { ops.iter().map(num).collect() };
    ops.into_iter()
        .map(|op| {
            let o = op.operands.clone();
            match op.operator.as_str() {
                "q" => stack.push((fill, stroke)),
                "Q" => (fill, stroke) = stack.pop().unwrap_or((0, 0)),
                "rg" | "RG" => {
                    if let Some([r, g, b]) = nums(&o).as_deref().map(|v| [v[0], v[1], v[2]]).filter(|_| o.len() == 3) {
                        let name = if op.operator == "rg" { "g" } else { "G" };
                        if op.operator == "rg" { fill = 0 } else { stroke = 0 }
                        return Operation::new(name, vec![real(luma(r, g, b))]);
                    }
                }
                "k" | "K" => {
                    if let Some(v) = nums(&o).filter(|v| v.len() == 4) {
                        let name = if op.operator == "k" { "g" } else { "G" };
                        if op.operator == "k" { fill = 0 } else { stroke = 0 }
                        return Operation::new(name, vec![real(cmyk_luma(v[0], v[1], v[2], v[3]))]);
                    }
                }
                "cs" | "CS" => {
                    let n = o.first().and_then(|n| n.as_name().ok()).and_then(|n| convertible_space(doc, resources, n)).unwrap_or(0);
                    if op.operator == "cs" { fill = n } else { stroke = n }
                    if n > 0 {
                        return Operation::new(&op.operator, vec![Object::Name(b"DeviceGray".to_vec())]);
                    }
                }
                "sc" | "scn" | "SC" | "SCN" => {
                    let comps = if op.operator.starts_with('s') { fill } else { stroke };
                    if comps > 0
                        && let Some(v) = nums(&o).filter(|v| v.len() == comps as usize)
                    {
                        let g = if comps == 3 { luma(v[0], v[1], v[2]) } else { cmyk_luma(v[0], v[1], v[2], v[3]) };
                        return Operation::new(&op.operator, vec![real(g)]);
                    }
                }
                _ => {}
            }
            op
        })
        .collect()
}

fn gray_image(doc: &Document, id: ObjectId) -> Option<Stream> {
    let s = doc.get_object(id).ok()?.as_stream().ok()?;
    let d = &s.dict;
    if d.has(b"Decode") || d.get(b"ImageMask").and_then(Object::as_bool).unwrap_or(false) {
        return None;
    }
    let w = d.get(b"Width").ok()?.as_i64().ok()? as u32;
    let h = d.get(b"Height").ok()?.as_i64().ok()? as u32;
    let cs = resolve(doc, d.get(b"ColorSpace").ok()?);
    // Indexed images: grey out the palette and keep everything else.
    if let Object::Array(a) = cs
        && a.first().and_then(|o| o.as_name().ok()) == Some(b"Indexed")
        && matches!(resolve(doc, a.get(1)?), Object::Name(n) if n == b"DeviceRGB")
    {
        let lookup = match resolve(doc, a.get(3)?) {
            Object::String(b, _) => b.clone(),
            Object::Stream(st) => st.decompressed_content().ok()?,
            _ => return None,
        };
        let grey: Vec<u8> = lookup.chunks(3).flat_map(|c| if c.len() == 3 { let g = (luma(c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0) * 255.0) as u8; vec![g, g, g] } else { c.to_vec() }).collect();
        let mut out = s.clone();
        out.dict.set("ColorSpace", vec![Object::Name(b"Indexed".to_vec()), Object::Name(b"DeviceRGB".to_vec()), a[2].clone(), Object::String(grey, lopdf::StringFormat::Hexadecimal)]);
        return Some(out);
    }
    let comps = match cs {
        Object::Name(n) if n == b"DeviceRGB" => 3,
        Object::Array(a) if a.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => resolve(doc, a.get(1)?).as_stream().ok()?.dict.get(b"N").ok()?.as_i64().ok()?,
        _ => return None,
    };
    if comps != 3 {
        return None;
    }
    let filters: Vec<Vec<u8>> = match d.get(b"Filter") {
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_name().ok().map(<[u8]>::to_vec)).collect(),
        _ => vec![],
    };
    let rgb = if filters == [b"DCTDecode".to_vec()] {
        match image::load_from_memory_with_format(&s.content, ImageFormat::Jpeg).ok()? {
            DynamicImage::ImageRgb8(i) => i,
            _ => return None,
        }
    } else if filters.iter().all(|f| f == b"FlateDecode") && d.get(b"BitsPerComponent").ok()?.as_i64().ok()? == 8 {
        let raw = s.decompressed_content_with_limit(w as usize * h as usize * 3 + 1).ok()?;
        RgbImage::from_raw(w, h, raw.get(..w as usize * h as usize * 3)?.to_vec())?
    } else {
        return None;
    };
    let grey: GrayImage = DynamicImage::ImageRgb8(rgb).to_luma8();
    let mut dict = d.clone();
    dict.set("ColorSpace", "DeviceGray");
    dict.set("BitsPerComponent", 8);
    dict.remove(b"DecodeParms");
    if filters == [b"DCTDecode".to_vec()] {
        let mut buf = Cursor::new(Vec::new());
        JpegEncoder::new_with_quality(&mut buf, 88).encode_image(&DynamicImage::ImageLuma8(grey)).ok()?;
        let jpeg = buf.into_inner();
        dict.set("ColorSpace", crate::images::jpeg_color_space(&jpeg));
        dict.set("Filter", "DCTDecode");
        Some(Stream::new(dict, jpeg).with_compression(false))
    } else {
        dict.remove(b"Filter");
        let mut st = Stream::new(dict, grey.into_raw());
        st.compress().ok()?;
        Some(st)
    }
}

pub fn grayscale(bytes: &[u8]) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    // Content streams: page contents (with the page's resources) and form XObjects (with their own).
    let mut jobs: Vec<(ObjectId, Option<Dictionary>)> = Vec::new();
    for page in page_ids(&doc) {
        let res = doc.get_page_resources(page).ok().and_then(|(d, ids)| d.cloned().or_else(|| ids.first().and_then(|id| doc.get_dictionary(*id).ok().cloned())));
        for c in doc.get_page_contents(page) {
            jobs.push((c, res.clone()));
        }
    }
    for (id, obj) in &doc.objects {
        if let Ok(s) = obj.as_stream()
            && s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Form")
        {
            let res = s.dict.get(b"Resources").ok().map(|r| resolve(&doc, r)).and_then(|r| r.as_dict().ok()).cloned();
            jobs.push((*id, res));
        }
    }
    let mut updates = Vec::new();
    for (id, res) in jobs {
        let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else { continue };
        let Ok(raw) = stream.decompressed_content() else { continue };
        let Ok(content) = Content::decode(&raw) else { continue };
        let ops = gray_ops(&doc, res.as_ref(), content.operations);
        if let Ok(encoded) = (Content { operations: ops }).encode() {
            updates.push((id, encoded));
        }
    }
    for (id, content) in updates {
        if let Ok(Object::Stream(s)) = doc.get_object_mut(id) {
            s.dict.remove(b"Filter");
            s.dict.remove(b"DecodeParms");
            s.set_plain_content(content);
            let _ = s.compress();
        }
    }
    let images: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter(|(_, o)| o.as_stream().map(|s| s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")).unwrap_or(false))
        .map(|(id, _)| *id)
        .collect();
    for id in images {
        if let Some(st) = gray_image(&doc, id) {
            doc.objects.insert(id, Object::Stream(st));
        }
    }
    finish(doc, false)
}

/* ---------- Annotations ---------- */

fn annots_of(doc: &Document, page: ObjectId) -> Vec<Object> {
    match doc.get_dictionary(page).and_then(|p| p.get(b"Annots")) {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(r)) => doc.get_object(*r).and_then(Object::as_array).cloned().unwrap_or_default(),
        _ => vec![],
    }
}

fn annot_dict<'a>(doc: &'a Document, a: &'a Object) -> Option<&'a Dictionary> {
    resolve(doc, a).as_dict().ok()
}

/// Removes comments, highlights, stamps and drawings. Form fields stay; links stay if asked.
pub fn remove_annotations(bytes: &[u8], keep_links: bool) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    for page in page_ids(&doc) {
        let kept: Vec<Object> = annots_of(&doc, page)
            .into_iter()
            .filter(|a| {
                let sub = annot_dict(&doc, a).and_then(|d| d.get(b"Subtype").ok()).and_then(|s| s.as_name().ok()).unwrap_or(b"");
                sub == b"Widget" || (keep_links && sub == b"Link")
            })
            .collect();
        doc.get_dictionary_mut(page).map_err(e)?.set("Annots", kept);
    }
    finish(doc, false)
}

/// Draws every annotation's appearance into the page and removes the annotation,
/// then drops the interactive form. Links keep working.
pub fn flatten(bytes: &[u8]) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    for page in page_ids(&doc) {
        let mut ops = Vec::new();
        let mut xobjects: Vec<(String, ObjectId)> = Vec::new();
        let mut kept = Vec::new();
        for (i, a) in annots_of(&doc, page).into_iter().enumerate() {
            let Some(d) = annot_dict(&doc, &a) else { continue };
            let sub = d.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");
            if sub == b"Link" {
                kept.push(a.clone());
                continue;
            }
            if sub == b"Popup" {
                continue;
            }
            let flags = d.get(b"F").and_then(Object::as_i64).unwrap_or(0);
            if flags & 0b10 != 0 {
                continue; // hidden
            }
            // Normal appearance; for checkboxes and radio buttons pick the current state.
            let Some(ap) = d.get(b"AP").ok().map(|o| resolve(&doc, o)).and_then(|o| o.as_dict().ok()) else { continue };
            let Some(n) = ap.get(b"N").ok() else { continue };
            let form_id = match resolve(&doc, n) {
                Object::Stream(_) => n.as_reference().ok(),
                Object::Dictionary(states) => {
                    let state = d.get(b"AS").and_then(Object::as_name).ok();
                    state.and_then(|s| states.get(s).ok()).and_then(|o| o.as_reference().ok())
                }
                _ => None,
            };
            let Some(form_id) = form_id else { continue };
            let Ok(form) = doc.get_object(form_id).and_then(Object::as_stream) else { continue };
            let rect: Vec<f32> = d.get(b"Rect").ok().map(|o| resolve(&doc, o)).and_then(|o| o.as_array().ok()).map(|a| a.iter().filter_map(num).collect()).unwrap_or_default();
            let bbox: Vec<f32> = form.dict.get(b"BBox").ok().map(|o| resolve(&doc, o)).and_then(|o| o.as_array().ok()).map(|a| a.iter().filter_map(num).collect()).unwrap_or_default();
            if rect.len() != 4 || bbox.len() != 4 {
                continue;
            }
            let m: Vec<f32> = form.dict.get(b"Matrix").ok().and_then(|o| o.as_array().ok()).map(|a| a.iter().filter_map(num).collect()).filter(|v: &Vec<f32>| v.len() == 6).unwrap_or(vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
            // Transformed bounding box of the appearance, mapped onto the annotation rectangle.
            let pts = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])].map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
            let (bx0, by0) = pts.iter().fold((f32::MAX, f32::MAX), |a, p| (a.0.min(p.0), a.1.min(p.1)));
            let (bx1, by1) = pts.iter().fold((f32::MIN, f32::MIN), |a, p| (a.0.max(p.0), a.1.max(p.1)));
            let (rx0, ry0, rx1, ry1) = (rect[0].min(rect[2]), rect[1].min(rect[3]), rect[0].max(rect[2]), rect[1].max(rect[3]));
            let sx = if bx1 > bx0 { (rx1 - rx0) / (bx1 - bx0) } else { 1.0 };
            let sy = if by1 > by0 { (ry1 - ry0) / (by1 - by0) } else { 1.0 };
            let name = format!("SPFl{i}");
            ops.push(Operation::new("q", vec![]));
            ops.push(Operation::new("cm", [sx, 0.0, 0.0, sy, rx0 - bx0 * sx, ry0 - by0 * sy].iter().map(|v| real(*v)).collect()));
            ops.push(Operation::new("Do", vec![name.as_str().into()]));
            ops.push(Operation::new("Q", vec![]));
            xobjects.push((name, form_id));
        }
        for (name, id) in &xobjects {
            crate::pages::add_resource(&mut doc, page, b"XObject", name.as_bytes(), *id)?;
        }
        if !ops.is_empty() {
            crate::pages::overlay_content(&mut doc, page, Content { operations: ops }.encode().map_err(e)?)?;
        }
        doc.get_dictionary_mut(page).map_err(e)?.set("Annots", kept);
    }
    if let Ok(c) = doc.catalog_mut() {
        c.remove(b"AcroForm");
    }
    finish(doc, false)
}

/* ---------- Images ---------- */

fn image_ids(doc: &Document) -> Vec<ObjectId> {
    let masks: BTreeSet<ObjectId> = doc.objects.values().filter_map(|o| o.as_stream().ok()).filter_map(|s| s.dict.get(b"SMask").and_then(Object::as_reference).ok()).collect();
    doc.objects
        .iter()
        .filter(|(id, o)| !masks.contains(id) && o.as_stream().map(|s| s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")).unwrap_or(false))
        .map(|(id, _)| *id)
        .collect()
}

/// Saves embedded pictures: JPEG and JPEG 2000 byte for byte, simple bitmaps as PNG.
pub fn extract_images(bytes: &[u8]) -> Res<Vec<u8>> {
    let doc = load(bytes)?;
    let mut zip = ZipWriter::default();
    let mut n = 0;
    for id in image_ids(&doc) {
        let Ok(s) = doc.get_object(id).and_then(Object::as_stream) else { continue };
        let d = &s.dict;
        let w = d.get(b"Width").and_then(Object::as_i64).unwrap_or(0) as u32;
        let h = d.get(b"Height").and_then(Object::as_i64).unwrap_or(0) as u32;
        if w < 24 || h < 24 || d.get(b"ImageMask").and_then(Object::as_bool).unwrap_or(false) {
            continue;
        }
        let filter = match d.get(b"Filter") {
            Ok(Object::Name(f)) => f.clone(),
            Ok(Object::Array(a)) if a.len() == 1 => a[0].as_name().map(<[u8]>::to_vec).unwrap_or_default(),
            _ => vec![],
        };
        let (ext, data) = match filter.as_slice() {
            b"DCTDecode" => ("jpg", s.content.clone()),
            b"JPXDecode" => ("jp2", s.content.clone()),
            _ => {
                let bpc = d.get(b"BitsPerComponent").and_then(Object::as_i64).unwrap_or(0);
                let Ok(raw) = s.decompressed_content_with_limit(w as usize * h as usize * 4 + 1) else { continue };
                let cs = d.get(b"ColorSpace").map(|o| resolve(&doc, o));
                let img = match (cs, bpc) {
                    (Ok(Object::Name(n)), 8) if n == b"DeviceRGB" => RgbImage::from_raw(w, h, raw.get(..(w * h * 3) as usize).map(<[u8]>::to_vec).unwrap_or_default()).map(DynamicImage::ImageRgb8),
                    (Ok(Object::Name(n)), 8) if n == b"DeviceGray" => GrayImage::from_raw(w, h, raw.get(..(w * h) as usize).map(<[u8]>::to_vec).unwrap_or_default()).map(DynamicImage::ImageLuma8),
                    (Ok(Object::Array(a)), 8) if a.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => {
                        let comps = a.get(1).map(|o| resolve(&doc, o)).and_then(|o| o.as_stream().ok()).and_then(|s| s.dict.get(b"N").ok()).and_then(|o| o.as_i64().ok()).unwrap_or(0);
                        match comps {
                            3 => RgbImage::from_raw(w, h, raw.get(..(w * h * 3) as usize).map(<[u8]>::to_vec).unwrap_or_default()).map(DynamicImage::ImageRgb8),
                            1 => GrayImage::from_raw(w, h, raw.get(..(w * h) as usize).map(<[u8]>::to_vec).unwrap_or_default()).map(DynamicImage::ImageLuma8),
                            _ => None,
                        }
                    }
                    _ => None,
                };
                let Some(img) = img else { continue };
                let mut buf = Cursor::new(Vec::new());
                if img.write_to(&mut buf, ImageFormat::Png).is_err() {
                    continue;
                }
                ("png", buf.into_inner())
            }
        };
        n += 1;
        zip.add(&format!("image-{n:03}.{ext}"), &data);
    }
    if n == 0 {
        return Err("INVALID: no extractable images were found in this PDF".into());
    }
    Ok(zip.finish())
}

/// Makes every image invisible and tiny: each becomes a 1×1 transparent mask.
pub fn remove_images(bytes: &[u8]) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    for id in image_ids(&doc) {
        let blank = Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1, "ImageMask" => true, "BitsPerComponent" => 1 },
            vec![0xFF],
        )
        .with_compression(false);
        doc.objects.insert(id, Object::Stream(blank));
    }
    finish(doc, true)
}

/// Replaces pages with pictures of themselves (JPEG), used for true redaction.
pub fn rasterize_pages(bytes: &[u8], pages: &[u32], jpegs: &[Vec<u8>], sizes: &[(u32, u32)]) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let ids = page_ids(&doc);
    for (i, n) in pages.iter().enumerate() {
        let id = *ids.get((*n as usize).wrapping_sub(1)).ok_or("INVALID: page does not exist")?;
        let (w, h) = sizes[i];
        let img = doc.add_object(
            Stream::new(
                dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Filter" => "DCTDecode" },
                jpegs[i].clone(),
            )
            .with_compression(false),
        );
        let g = PageGeom::of(&doc, id);
        let (vw, vh) = g.visual();
        let p = g.place(0.0, 0.0);
        let ops = vec![
            Operation::new("q", vec![]),
            Operation::new("cm", p.iter().map(|v| real(*v)).collect()),
            Operation::new("cm", vec![real(vw), real(0.0), real(0.0), real(vh), real(0.0), real(0.0)]),
            Operation::new("Do", vec!["Rz".into()]),
            Operation::new("Q", vec![]),
        ];
        let content = doc.add_object(Stream::new(Dictionary::new(), Content { operations: ops }.encode().map_err(e)?));
        let page = doc.get_dictionary_mut(id).map_err(e)?;
        page.set("Contents", content);
        page.set("Resources", dictionary! { "XObject" => dictionary! { "Rz" => img } });
        page.remove(b"Annots");
    }
    if let Ok(c) = doc.catalog_mut() {
        c.remove(b"AcroForm");
        c.remove(b"StructTreeRoot");
    }
    finish(doc, false)
}

/* ---------- Page layout ---------- */

fn blank_like(doc: &mut Document, page: ObjectId, root: ObjectId) -> ObjectId {
    let src = doc.get_dictionary(page).ok();
    let mut d = dictionary! { "Type" => "Page", "Parent" => root, "Resources" => Dictionary::new() };
    for key in [&b"MediaBox"[..], b"CropBox", b"Rotate"] {
        if let Some(v) = src.and_then(|s| s.get(key).ok()) {
            d.set(key, v.clone());
        }
    }
    doc.add_object(d)
}

fn root_id(doc: &Document) -> Res<ObjectId> {
    doc.catalog().and_then(|c| c.get(b"Pages")).and_then(Object::as_reference).map_err(e)
}

/// Inserts blank pages after each listed page number (0 = before the first), or after every page.
pub fn insert_blank(bytes: &[u8], after: &[u32], every: bool) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let ids = page_ids(&doc);
    let root = root_id(&doc)?;
    let mut list = Vec::new();
    if after.contains(&0) {
        list.push(blank_like(&mut doc, ids[0], root));
    }
    for (i, id) in ids.iter().enumerate() {
        list.push(*id);
        if every || after.contains(&(i as u32 + 1)) {
            list.push(blank_like(&mut doc, *id, root));
        }
    }
    set_page_list(&mut doc, &list)?;
    finish(doc, false)
}

/// Alternates the pages of two documents (A1, B1, A2, B2, …), optionally reading B backwards.
pub fn interleave(a: &[u8], b: &[u8], reverse_b: bool) -> Res<Vec<u8>> {
    let (na, nb) = (page_count(a)?, page_count(b)?);
    let merged = merge(&[a.to_vec(), b.to_vec()])?;
    let mut order = Vec::new();
    for i in 0..na.max(nb) {
        if i < na {
            order.push(i + 1);
        }
        if i < nb {
            order.push(na + if reverse_b { nb - i } else { i + 1 });
        }
    }
    organize(&merged, &order, &[])
}

/// Visible crop box for margins [left, top, right, bottom] given as fractions of the visible page.
fn crop_box(g: &PageGeom, m: [f32; 4]) -> [f32; 4] {
    let (vw, vh) = g.visual();
    let (l, t, r, b) = (m[0] * vw, m[1] * vh, m[2] * vw, m[3] * vh);
    let (ul, ur, ub, ut) = match g.rot {
        90 => (t, b, l, r),
        180 => (r, l, t, b),
        270 => (b, t, r, l),
        _ => (l, r, b, t),
    };
    [g.x0 + ul, g.y0 + ub, g.x0 + g.w - ur, g.y0 + g.h - ut]
}

/// Turns each page into two: left and right halves, or top and bottom halves.
pub fn split_half(bytes: &[u8], vertical_cut: bool, right_to_left: bool) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let mut list = Vec::new();
    for id in page_ids(&doc) {
        let g = PageGeom::of(&doc, id);
        let halves = if vertical_cut { [[0.0, 0.0, 0.5, 0.0], [0.5, 0.0, 0.0, 0.0]] } else { [[0.0, 0.0, 0.0, 0.5], [0.0, 0.5, 0.0, 0.0]] };
        let mut made = Vec::new();
        for m in halves {
            let mut d = doc.get_dictionary(id).map_err(e)?.clone();
            d.set("CropBox", crop_box(&g, m).iter().map(|v| real(*v)).collect::<Vec<_>>());
            d.remove(b"Annots");
            made.push(doc.add_object(d));
        }
        if vertical_cut && right_to_left {
            made.reverse();
        }
        list.extend(made);
    }
    set_page_list(&mut doc, &list)?;
    finish(doc, false)
}

/// Grows every page by `points` on each side; the content keeps its size.
pub fn add_margins(bytes: &[u8], points: f32) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    for id in page_ids(&doc) {
        let g = PageGeom::of(&doc, id);
        let b = [g.x0 - points, g.y0 - points, g.x0 + g.w + points, g.y0 + g.h + points];
        let page = doc.get_dictionary_mut(id).map_err(e)?;
        let bx: Vec<Object> = b.iter().map(|v| real(*v)).collect();
        page.set("MediaBox", bx.clone());
        page.set("CropBox", bx);
        for key in [&b"TrimBox"[..], b"ArtBox", b"BleedBox"] {
            page.remove(key);
        }
    }
    finish(doc, false)
}

/// Draws source pages onto new sheets. `sheets` lists, per sheet, its size and the
/// pages (0-based, `None` = leave empty) for each cell, with cells given as rectangles.
fn impose(mut doc: Document, sheets: Vec<((f32, f32), Vec<(Option<usize>, [f32; 4])>)>) -> Res<Vec<u8>> {
    let ids = page_ids(&doc);
    let mut forms = Vec::with_capacity(ids.len());
    for id in &ids {
        let g = PageGeom::of(&doc, *id);
        let content = doc.get_page_content(*id);
        let resources = doc.get_dictionary(*id).ok().and_then(|p| p.get(b"Resources").ok().cloned()).unwrap_or_else(|| Dictionary::new().into());
        let mut form = Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![real(g.x0), real(g.y0), real(g.x0 + g.w), real(g.y0 + g.h)], "Resources" => resources },
            content,
        );
        let _ = form.compress();
        forms.push((doc.add_object(form), g));
    }
    let root = root_id(&doc)?;
    let invert = |m: [f32; 6]| {
        let [a, b, c, d, e2, f] = m;
        let det = a * d - b * c;
        let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
        [ia, ib, ic, id, -(e2 * ia + f * ic), -(e2 * ib + f * id)]
    };
    let mut out = Vec::new();
    for ((sw, sh), cells) in sheets {
        let mut ops = Vec::new();
        let mut xobjects = Dictionary::new();
        for (i, (src, [cx, cy, cw, ch])) in cells.iter().enumerate() {
            let Some(src) = src else { continue };
            let (form, g) = &forms[*src];
            let (vw, vh) = g.visual();
            let s = (cw / vw).min(ch / vh);
            let (dw, dh) = (vw * s, vh * s);
            let (x, y) = (cx + (cw - dw) / 2.0, cy + (ch - dh) / 2.0);
            let name = format!("P{i}");
            xobjects.set(name.as_bytes(), *form);
            ops.push(Operation::new("q", vec![]));
            ops.push(Operation::new("cm", vec![real(s), real(0.0), real(0.0), real(s), real(x), real(y)]));
            ops.push(Operation::new("cm", invert(g.place(0.0, 0.0)).iter().map(|v| real(*v)).collect()));
            ops.push(Operation::new("re", vec![real(g.x0), real(g.y0), real(g.w), real(g.h)]));
            ops.push(Operation::new("W", vec![]));
            ops.push(Operation::new("n", vec![]));
            ops.push(Operation::new("Do", vec![name.as_str().into()]));
            ops.push(Operation::new("Q", vec![]));
        }
        let content = doc.add_object(Stream::new(Dictionary::new(), Content { operations: ops }.encode().map_err(e)?));
        out.push(doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => root, "MediaBox" => vec![0.into(), 0.into(), real(sw), real(sh)],
            "Contents" => content, "Resources" => dictionary! { "XObject" => xobjects },
        }));
    }
    set_page_list(&mut doc, &out)?;
    doc.compress();
    finish(doc, false)
}

fn paper(name: &str) -> Option<(f32, f32)> {
    match name {
        "a3" => Some((841.89, 1190.55)),
        "a4" => Some((595.28, 841.89)),
        "a5" => Some((419.53, 595.28)),
        "letter" => Some((612.0, 792.0)),
        "legal" => Some((612.0, 1008.0)),
        _ => None,
    }
}

/// Scales every page onto a standard paper size, turning the sheet to match each page.
pub fn resize(bytes: &[u8], paper_name: &str) -> Res<Vec<u8>> {
    let (pw, ph) = paper(paper_name).ok_or("INVALID: unknown paper size")?;
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let sheets = page_ids(&doc)
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let (vw, vh) = PageGeom::of(&doc, *id).visual();
            let (sw, sh) = if vw > vh { (ph, pw) } else { (pw, ph) };
            ((sw, sh), vec![(Some(i), [0.0, 0.0, sw, sh])])
        })
        .collect();
    impose(doc, sheets)
}

/// Saddle-stitch booklet: two pages per landscape sheet side, in folding order.
pub fn booklet(bytes: &[u8], paper_name: &str) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let ids = page_ids(&doc);
    let n = ids.len();
    let total = n.div_ceil(4) * 4;
    let first = PageGeom::of(&doc, ids[0]).visual();
    let (pw, ph) = paper(paper_name).unwrap_or((first.0.min(first.1), first.0.max(first.1)));
    let (sw, sh) = (ph, pw);
    let page = |i: usize| (i < n).then_some(i);
    let left = [0.0, 0.0, sw / 2.0, sh];
    let right = [sw / 2.0, 0.0, sw / 2.0, sh];
    let mut sheets = Vec::new();
    for s in 0..total / 4 {
        sheets.push(((sw, sh), vec![(page(total - 1 - 2 * s), left), (page(2 * s), right)]));
        sheets.push(((sw, sh), vec![(page(2 * s + 1), left), (page(total - 2 - 2 * s), right)]));
    }
    impose(doc, sheets)
}

/* ---------- Splitting ---------- */

fn part(doc: &Document, pages: &[u32]) -> Res<Vec<u8>> {
    let mut d = doc.clone();
    let ids = page_ids(&d);
    let chosen: Vec<ObjectId> = pages.iter().map(|n| ids[*n as usize - 1]).collect();
    set_page_list(&mut d, &chosen)?;
    finish(d, false)
}

/// Splits into parts no bigger than `max_bytes`, never splitting a page.
pub fn split_by_size(bytes: &[u8], max_bytes: usize, base: &str) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let n = page_ids(&doc).len() as u32;
    let mut zip = ZipWriter::default();
    let mut start = 1u32;
    let mut index = 0;
    while start <= n {
        // Grow the part exponentially, then binary-search the largest end that fits.
        let fits = |end: u32| -> Res<Option<Vec<u8>>> {
            let bytes = part(&doc, &(start..=end).collect::<Vec<_>>())?;
            Ok((bytes.len() <= max_bytes).then_some(bytes))
        };
        let mut best = (start, part(&doc, &[start])?);
        let mut step = 1;
        let lo = start;
        let mut hi = n + 1;
        while lo + step <= n {
            match fits(lo + step)? {
                Some(b) => {
                    best = (lo + step, b);
                    step *= 2;
                }
                None => {
                    hi = lo + step;
                    break;
                }
            }
        }
        let (mut a, mut b) = (best.0, hi.min(n + 1));
        while b - a > 1 {
            let mid = (a + b) / 2;
            match fits(mid)? {
                Some(bytes) => {
                    best = (mid, bytes);
                    a = mid;
                }
                None => b = mid,
            }
        }
        index += 1;
        zip.add(&format!("{base}-part-{index}.pdf"), &best.1);
        start = best.0 + 1;
    }
    Ok(zip.finish())
}

/// One file per top-level bookmark; pages before the first bookmark form their own file.
pub fn split_by_bookmarks(bytes: &[u8], base: &str) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    let toc = doc.get_toc().map_err(|_| "INVALID: this PDF has no bookmarks".to_string())?;
    let n = page_ids(&doc).len();
    let mut starts: Vec<(usize, String)> = toc.toc.iter().filter(|t| t.level == 1 && t.page >= 1 && t.page <= n).map(|t| (t.page, t.title.clone())).collect();
    starts.sort_by_key(|s| s.0);
    starts.dedup_by_key(|s| s.0);
    if starts.is_empty() {
        return Err("INVALID: this PDF has no bookmarks".into());
    }
    bake_inherited(&mut doc);
    if starts[0].0 > 1 {
        starts.insert(0, (1, "start".into()));
    }
    let mut zip = ZipWriter::default();
    for (i, (page, title)) in starts.iter().enumerate() {
        let end = starts.get(i + 1).map(|s| s.0 - 1).unwrap_or(n);
        let safe: String = title.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect::<String>().trim().chars().take(60).collect();
        zip.add(&format!("{base}-{:02}-{}.pdf", i + 1, if safe.is_empty() { "part".into() } else { safe }), &part(&doc, &(*page as u32..=end as u32).collect::<Vec<_>>())?);
    }
    Ok(zip.finish())
}

/* ---------- Inspection ---------- */

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn text_of(o: &Object) -> String {
    match o {
        Object::String(b, _) if b.starts_with(&[0xFE, 0xFF]) => {
            let units: Vec<u16> = b[2..].chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            String::from_utf16_lossy(&units)
        }
        Object::String(b, _) => b.iter().map(|c| *c as char).collect(),
        Object::Name(n) => String::from_utf8_lossy(n).into_owned(),
        _ => String::new(),
    }
}

/// Everything worth knowing about a file, as JSON for the page to display.
pub fn info(bytes: &[u8]) -> Res<String> {
    let doc = load(bytes)?;
    let ids = page_ids(&doc);
    let mut sizes: BTreeMap<String, u32> = BTreeMap::new();
    for id in &ids {
        let (w, h) = PageGeom::of(&doc, *id).visual();
        *sizes.entry(format!("{:.0}x{:.0}", w, h)).or_default() += 1;
    }
    let mut fonts: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for obj in doc.objects.values() {
        let Ok(d) = obj.as_dict() else { continue };
        if !d.has_type(b"Font") {
            continue;
        }
        let name = d.get(b"BaseFont").map(text_of).unwrap_or_default();
        let sub = d.get(b"Subtype").map(text_of).unwrap_or_default();
        if sub == "Type0" || name.is_empty() {
            continue;
        }
        let embedded = d
            .get(b"FontDescriptor")
            .ok()
            .map(|fd| resolve(&doc, fd))
            .and_then(|fd| fd.as_dict().ok())
            .map(|fd| fd.has(b"FontFile") || fd.has(b"FontFile2") || fd.has(b"FontFile3"))
            .unwrap_or(false);
        let clean = name.split_once('+').map(|(_, n)| n.to_string()).unwrap_or(name);
        let entry = fonts.entry(clean).or_insert((sub, embedded));
        entry.1 |= embedded;
    }
    let catalog = doc.catalog().ok();
    let names = catalog.and_then(|c| c.get(b"Names").ok()).map(|o| resolve(&doc, o)).and_then(|o| o.as_dict().ok());
    let has_js = names.map(|n| n.has(b"JavaScript")).unwrap_or(false)
        || doc.objects.values().any(|o| o.as_dict().map(|d| d.get(b"S").and_then(Object::as_name).ok() == Some(b"JavaScript")).unwrap_or(false));
    let attachments = names.map(|n| n.has(b"EmbeddedFiles")).unwrap_or(false);
    let forms = catalog.and_then(|c| c.get(b"AcroForm").ok()).map(|o| resolve(&doc, o)).and_then(|o| o.as_dict().ok()).and_then(|f| f.get(b"Fields").ok()).map(|o| resolve(&doc, o)).and_then(|o| o.as_array().ok()).map(|a| a.len()).unwrap_or(0);
    let tagged = catalog.and_then(|c| c.get(b"MarkInfo").ok()).map(|o| resolve(&doc, o)).and_then(|o| o.as_dict().ok()).and_then(|m| m.get(b"Marked").ok()).and_then(|o| o.as_bool().ok()).unwrap_or(false);
    let outline = catalog.map(|c| c.has(b"Outlines")).unwrap_or(false);
    let info = doc.trailer.get(b"Info").ok().map(|o| resolve(&doc, o)).and_then(|o| o.as_dict().ok());
    let meta: Vec<String> = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]
        .iter()
        .filter_map(|k| info.and_then(|i| i.get(k.as_bytes()).ok()).map(|v| format!("{}:{}", json_str(k), json_str(&text_of(resolve(&doc, v))))))
        .collect();
    Ok(format!(
        "{{\"version\":{},\"pages\":{},\"sizes\":{{{}}},\"fonts\":[{}],\"images\":{},\"formFields\":{},\"javascript\":{},\"attachments\":{},\"tagged\":{},\"bookmarks\":{},\"wasEncrypted\":{},\"metadata\":{{{}}}}}",
        json_str(&doc.version),
        ids.len(),
        sizes.iter().map(|(k, v)| format!("{}:{}", json_str(k), v)).collect::<Vec<_>>().join(","),
        fonts.iter().map(|(n, (s, emb))| format!("{{\"name\":{},\"type\":{},\"embedded\":{}}}", json_str(n), json_str(s), emb)).collect::<Vec<_>>().join(","),
        image_ids(&doc).len(),
        forms,
        has_js,
        attachments,
        tagged,
        outline,
        doc.was_encrypted(),
        meta.join(",")
    ))
}

/* ---------- Bookmarks and backgrounds ---------- */

/// Replaces the document's bookmarks with a flat list of (title, 1-based page).
pub fn set_bookmarks(bytes: &[u8], entries: &[(String, u32)]) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    let ids = page_ids(&doc);
    if let Ok(c) = doc.catalog_mut() {
        c.remove(b"Outlines");
    }
    doc.bookmarks.clear();
    doc.bookmark_table.clear();
    for (title, page) in entries {
        let Some(id) = ids.get((*page as usize).wrapping_sub(1)) else { continue };
        let title = if title.trim().is_empty() { format!("{page}") } else { title.trim().to_string() };
        doc.add_bookmark(lopdf::Bookmark::new(title, [0.0, 0.0, 0.0], 0, *id), None);
    }
    if let Some(outline) = doc.build_outline() {
        let catalog = doc.catalog_mut().map_err(e)?;
        catalog.set("Outlines", outline);
        catalog.set("PageMode", "UseOutlines");
    } else if let Ok(c) = doc.catalog_mut() {
        c.remove(b"PageMode");
    }
    finish(doc, false)
}

/// Draws the first page of `background` on every page (or only the first) of `bytes`,
/// behind the content (letterhead, stationery) or on top of it (overlay).
pub fn add_background(bytes: &[u8], background: &[u8], on_top: bool, first_only: bool) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let mut bg = load(background)?;
    bake_inherited(&mut bg);
    bg.renumber_objects_with(doc.max_id + 1);
    let bg_page = *page_ids(&bg).first().ok_or("INVALID: the background PDF has no pages")?;
    let g = PageGeom::of(&bg, bg_page);
    let content = bg.get_page_content(bg_page);
    let resources = bg.get_dictionary(bg_page).ok().and_then(|p| p.get(b"Resources").ok().cloned()).unwrap_or_else(|| Dictionary::new().into());
    doc.max_id = doc.max_id.max(bg.max_id);
    doc.objects.extend(bg.objects);
    let mut form = Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![real(g.x0), real(g.y0), real(g.x0 + g.w), real(g.y0 + g.h)], "Resources" => resources },
        content,
    );
    let _ = form.compress();
    let form_id = doc.add_object(form);
    let (bw, bh) = g.visual();
    let to_visual = {
        let [a, b, c, d, e2, f] = g.place(0.0, 0.0);
        let det = a * d - b * c;
        let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
        [ia, ib, ic, id, -(e2 * ia + f * ic), -(e2 * ib + f * id)]
    };
    for (i, id) in page_ids(&doc).into_iter().enumerate() {
        if first_only && i > 0 {
            break;
        }
        let pg = PageGeom::of(&doc, id);
        let (vw, vh) = pg.visual();
        // Stretch the background page to cover the target page as the reader sees it.
        let ops = vec![
            Operation::new("q", vec![]),
            Operation::new("cm", pg.place(0.0, 0.0).iter().map(|v| real(*v)).collect()),
            Operation::new("cm", vec![real(vw / bw), real(0.0), real(0.0), real(vh / bh), real(0.0), real(0.0)]),
            Operation::new("cm", to_visual.iter().map(|v| real(*v)).collect()),
            Operation::new("Do", vec!["SPBg".into()]),
            Operation::new("Q", vec![]),
        ];
        let encoded = Content { operations: ops }.encode().map_err(e)?;
        crate::pages::add_resource(&mut doc, id, b"XObject", b"SPBg", form_id)?;
        if on_top {
            crate::pages::overlay_content(&mut doc, id, encoded)?;
        } else {
            let stream = doc.add_object(Stream::new(Dictionary::new(), encoded));
            let mut contents = vec![Object::Reference(stream)];
            match doc.get_dictionary(id).map_err(e)?.get(b"Contents") {
                Ok(Object::Reference(r)) => match doc.get_object(*r) {
                    Ok(Object::Array(a)) => contents.extend(a.clone()),
                    _ => contents.push(Object::Reference(*r)),
                },
                Ok(Object::Array(a)) => contents.extend(a.clone()),
                _ => {}
            }
            doc.get_dictionary_mut(id).map_err(e)?.set("Contents", contents);
        }
    }
    finish(doc, false)
}
