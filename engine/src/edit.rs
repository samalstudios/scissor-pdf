//! Page-level edits: crop, pages per sheet, placed images (signatures, text), metadata, repair.

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Object, ObjectId, Stream, dictionary};

use crate::Res;
use crate::images::rgba_xobject;
use crate::ops::{finish, finish_with, load};
use crate::pages::{PageGeom, add_resource, bake_inherited, overlay_content, page_ids, set_page_list};

fn real(v: f32) -> Object {
    Object::Real(v)
}

fn cm(m: [f32; 6]) -> Operation {
    Operation::new("cm", m.iter().map(|v| real(*v)).collect())
}

fn invert(m: [f32; 6]) -> [f32; 6] {
    let [a, b, c, d, e, f] = m;
    let det = a * d - b * c;
    let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
    [ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)]
}

/// Trims each listed page (1-based; empty = all) by margins given as fractions of the
/// visible width and height: [left, top, right, bottom] as the reader sees the page.
pub fn crop(bytes: &[u8], pages: &[u32], margins: [f32; 4]) -> Res<Vec<u8>> {
    let [ml, mt, mr, mb] = margins.map(|m| m.clamp(0.0, 0.45));
    if ml + mr >= 0.9 || mt + mb >= 0.9 {
        return Err("INVALID: margins leave nothing of the page".into());
    }
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let ids = page_ids(&doc);
    for (i, id) in ids.iter().enumerate() {
        if !pages.is_empty() && !pages.contains(&(i as u32 + 1)) {
            continue;
        }
        let g = PageGeom::of(&doc, *id);
        let (vw, vh) = g.visual();
        // Margins in points on the visual edges, mapped to the user-space edges they become.
        let (l, t, r, b) = (ml * vw, mt * vh, mr * vw, mb * vh);
        let (ul, ur, ub, ut) = match g.rot {
            90 => (t, b, l, r),
            180 => (r, l, t, b),
            270 => (b, t, r, l),
            _ => (l, r, b, t),
        };
        let bx = [g.x0 + ul, g.y0 + ub, g.x0 + g.w - ur, g.y0 + g.h - ut];
        let page = doc.get_dictionary_mut(*id).map_err(|e| e.to_string())?;
        page.set("CropBox", bx.iter().map(|v| real(*v)).collect::<Vec<_>>());
        for key in [&b"TrimBox"[..], b"ArtBox", b"BleedBox"] {
            page.remove(key);
        }
    }
    finish(doc, false)
}

/// Puts 2 or 4 pages on each sheet. `paper` is "a4", "letter" or "auto" (follows the first page).
pub fn n_up(bytes: &[u8], per_sheet: u32, paper: &str) -> Res<Vec<u8>> {
    let (cols, rows) = match per_sheet {
        2 => (2u32, 1u32),
        4 => (2, 2),
        _ => return Err("INVALID: choose 2 or 4 pages per sheet".into()),
    };
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let ids = page_ids(&doc);
    let first = PageGeom::of(&doc, ids[0]).visual();
    let (pw, ph) = match paper {
        "a4" => (595.28, 841.89),
        "letter" => (612.0, 792.0),
        _ => (first.0.min(first.1), first.0.max(first.1)),
    };
    // Two pages sit side by side on a landscape sheet; four fill a portrait sheet.
    let (sw, sh) = if per_sheet == 2 { (ph, pw) } else { (pw, ph) };
    let (margin, gap) = (18.0f32, 12.0f32);
    let cell_w = (sw - 2.0 * margin - gap * (cols - 1) as f32) / cols as f32;
    let cell_h = (sh - 2.0 * margin - gap * (rows - 1) as f32) / rows as f32;

    // Each source page becomes a form XObject that can be drawn anywhere.
    let mut forms = Vec::with_capacity(ids.len());
    for id in &ids {
        let g = PageGeom::of(&doc, *id);
        let content = doc.get_page_content(*id);
        let resources = doc.get_dictionary(*id).ok().and_then(|p| p.get(b"Resources").ok().cloned()).unwrap_or_else(|| Dictionary::new().into());
        let mut form = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![real(g.x0), real(g.y0), real(g.x0 + g.w), real(g.y0 + g.h)],
                "Resources" => resources,
            },
            content,
        );
        let _ = form.compress();
        forms.push((doc.add_object(form), g));
    }

    let root = doc.catalog().and_then(|c| c.get(b"Pages")).and_then(Object::as_reference).map_err(|e| e.to_string())?;
    let mut sheets = Vec::new();
    for chunk in forms.chunks(per_sheet as usize) {
        let mut ops = Vec::new();
        let mut xobjects = Dictionary::new();
        for (i, (form, g)) in chunk.iter().enumerate() {
            let (col, row) = (i as u32 % cols, i as u32 / cols);
            let (vw, vh) = g.visual();
            let s = (cell_w / vw).min(cell_h / vh);
            let (dw, dh) = (vw * s, vh * s);
            let x = margin + col as f32 * (cell_w + gap) + (cell_w - dw) / 2.0;
            let y = sh - margin - (row + 1) as f32 * cell_h - row as f32 * gap + (cell_h - dh) / 2.0;
            let name = format!("P{i}");
            xobjects.set(name.as_bytes(), *form);
            ops.push(Operation::new("q", vec![]));
            ops.push(cm([s, 0.0, 0.0, s, x, y]));
            // User space to upright visual space, so rotated pages land the right way up.
            ops.push(cm(invert(g.place(0.0, 0.0))));
            ops.push(Operation::new("re", vec![real(g.x0), real(g.y0), real(g.w), real(g.h)]));
            ops.push(Operation::new("W", vec![]));
            ops.push(Operation::new("n", vec![]));
            ops.push(Operation::new("Do", vec![name.as_str().into()]));
            ops.push(Operation::new("Q", vec![]));
        }
        let content = doc.add_object(Stream::new(Dictionary::new(), Content { operations: ops }.encode().map_err(|e| e.to_string())?));
        let sheet = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => root,
            "MediaBox" => vec![0.into(), 0.into(), real(sw), real(sh)],
            "Contents" => content,
            "Resources" => dictionary! { "XObject" => xobjects },
        });
        sheets.push(sheet);
    }
    set_page_list(&mut doc, &sheets)?;
    doc.compress();
    finish(doc, false)
}

/// One image placed on a page: position and size as fractions of the visible page,
/// measured from its top-left corner as the reader sees it.
pub struct Placement {
    pub page: u32,
    pub rect: [f32; 4],
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Draws signatures, text and images onto pages.
pub fn place_images(bytes: &[u8], items: &[Placement]) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    let ids = page_ids(&doc);
    let mut per_page: std::collections::BTreeMap<u32, Vec<Operation>> = Default::default();
    for (n, item) in items.iter().enumerate() {
        let id = *ids.get((item.page as usize).wrapping_sub(1)).ok_or_else(|| format!("INVALID: page {} does not exist", item.page))?;
        let image = rgba_xobject(&mut doc, &item.rgba, item.width, item.height)?;
        let name = format!("SPIm{n}");
        add_resource(&mut doc, id, b"XObject", name.as_bytes(), image)?;
        let g = PageGeom::of(&doc, id);
        let (vw, vh) = g.visual();
        let [fx, fy, fw, fh] = item.rect;
        let (w, h) = (fw * vw, fh * vh);
        let (x, y) = (fx * vw, vh - fy * vh - h);
        let ops = per_page.entry(item.page).or_default();
        ops.push(Operation::new("q", vec![]));
        ops.push(cm(g.place(0.0, 0.0)));
        ops.push(cm([w, 0.0, 0.0, h, x, y]));
        ops.push(Operation::new("Do", vec![name.as_str().into()]));
        ops.push(Operation::new("Q", vec![]));
    }
    for (page, ops) in per_page {
        let id = ids[page as usize - 1];
        overlay_content(&mut doc, id, Content { operations: ops }.encode().map_err(|e| e.to_string())?)?;
    }
    finish(doc, false)
}

/// Sets the document information fields, or removes all metadata when `wipe` is true.
/// Embedded XMP metadata is removed in both cases so readers show the values set here.
pub fn metadata(bytes: &[u8], fields: &[(&str, &str)], wipe: bool) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    if let Ok(catalog) = doc.catalog_mut() {
        catalog.remove(b"Metadata");
    }
    if wipe {
        doc.trailer.remove(b"Info");
        for id in doc.page_iter().collect::<Vec<_>>() {
            if let Ok(page) = doc.get_dictionary_mut(id) {
                page.remove(b"Metadata");
                page.remove(b"PieceInfo");
            }
        }
        return finish_with(doc, false, false);
    }
    let info_id = match doc.trailer.get(b"Info").and_then(Object::as_reference) {
        Ok(id) => id,
        Err(_) => {
            let id = doc.add_object(Dictionary::new());
            doc.trailer.set("Info", id);
            id
        }
    };
    let info = doc.get_dictionary_mut(info_id).map_err(|e| e.to_string())?;
    for (key, value) in fields {
        if value.trim().is_empty() {
            info.remove(key.as_bytes());
        } else {
            info.set(*key, text_string(value));
        }
    }
    finish_with(doc, false, false)
}

/// PDF text string: plain bytes for ASCII, UTF-16BE with a byte-order mark otherwise.
fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        Object::string_literal(s)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in s.encode_utf16() {
            bytes.extend(unit.to_be_bytes());
        }
        Object::String(bytes, lopdf::StringFormat::Hexadecimal)
    }
}

/// Rebuilds a damaged file: the reader reconstructs a broken cross-reference table, and a
/// missing or broken page tree is rebuilt from every page object found in the file.
pub fn repair(bytes: &[u8]) -> Res<(Vec<u8>, u32)> {
    let mut doc = match load(bytes) {
        Ok(doc) => doc,
        Err(e) if e.starts_with("ENCRYPTED") => return Err(e),
        // A cut-off file has lost its trailer, which the reader needs to start from.
        Err(_) => load(&with_trailer(bytes)).map_err(|_| "INVALID: no pages could be recovered from this file".to_string())?,
    };
    if doc.get_pages().is_empty() {
        let mut found: Vec<ObjectId> = doc
            .objects
            .iter()
            .filter(|(_, o)| o.as_dict().map(|d| d.has_type(b"Page")).unwrap_or(false))
            .map(|(id, _)| *id)
            .collect();
        found.sort();
        if found.is_empty() {
            return Err("INVALID: no pages could be recovered from this file".into());
        }
        let pages_id = doc.new_object_id();
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => Vec::<Object>::new(), "Count" => 0 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        for id in &found {
            if let Ok(page) = doc.get_dictionary_mut(*id) {
                if !page.has(b"MediaBox") {
                    page.set("MediaBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
                }
            }
        }
        set_page_list(&mut doc, &found)?;
    }
    let count = doc.get_pages().len() as u32;
    Ok((finish(doc, false)?, count))
}

/// Appends a trailer pointing at the document catalog (or a new, empty one, whose page
/// tree `repair` then rebuilds) so a file that was cut off can be read again.
fn with_trailer(bytes: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes);
    let mut max = 0u32;
    let mut catalog = None;
    let mut last_obj = 0u32;
    let mut i = 0;
    while let Some(pos) = text[i..].find(" obj") {
        let at = i + pos;
        // Read "<num> <gen>" backwards from " obj".
        let head = &text[at.saturating_sub(24)..at];
        let mut parts = head.split_whitespace().rev();
        if let (Some(_gen), Some(num)) = (parts.next(), parts.next())
            && let Ok(n) = num.trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<u32>()
        {
            max = max.max(n);
            last_obj = n;
        }
        i = at + 4;
        let window = &text[i..(i + 300).min(text.len())];
        if catalog.is_none() && (window.contains("/Type /Catalog") || window.contains("/Type/Catalog")) {
            catalog = Some(last_obj);
        }
    }
    let mut out = bytes.to_vec();
    let root = match catalog {
        Some(n) => n,
        None => {
            let (c, p) = (max + 1, max + 2);
            out.extend(format!("\n{c} 0 obj\n<< /Type /Catalog /Pages {p} 0 R >>\nendobj\n{p} 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n").as_bytes());
            max = p;
            c
        }
    };
    out.extend(format!("\ntrailer\n<< /Root {root} 0 R /Size {} >>\n%%EOF\n", max + 1).as_bytes());
    out
}
