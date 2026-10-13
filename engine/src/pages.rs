//! Page-tree helpers shared by every operation that moves, drops or decorates pages.

use std::collections::BTreeSet;

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::Res;

const INHERITABLE: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];
const LETTER: [i64; 4] = [0, 0, 612, 792];

/// Copies attributes a page inherits from its ancestors onto the page itself,
/// so it keeps its size, rotation and fonts when it leaves its original tree.
pub fn bake_inherited(doc: &mut Document) {
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    for id in pages {
        let mut found = Vec::new();
        if let Ok(page) = doc.get_dictionary(id) {
            for key in INHERITABLE {
                if !page.has(key)
                    && let Some(value) = find_inherited(doc, page, key)
                {
                    found.push((key, value));
                }
            }
            if !page.has(b"MediaBox") && !found.iter().any(|(k, _)| *k == b"MediaBox") {
                found.push((b"MediaBox", LETTER.iter().map(|v| Object::Integer(*v)).collect::<Vec<_>>().into()));
            }
        }
        if let Ok(page) = doc.get_dictionary_mut(id) {
            for (key, value) in found {
                page.set(key, value);
            }
        }
    }
}

fn find_inherited(doc: &Document, page: &Dictionary, key: &[u8]) -> Option<Object> {
    let mut parent = page.get(b"Parent").and_then(Object::as_reference).ok();
    for _ in 0..64 {
        let node = doc.get_dictionary(parent?).ok()?;
        if let Ok(value) = node.get(key) {
            return Some(value.clone());
        }
        parent = node.get(b"Parent").and_then(Object::as_reference).ok();
    }
    None
}

/// Page object ids in reading order.
pub fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().into_values().collect()
}

fn root_pages_id(doc: &Document) -> Res<ObjectId> {
    doc.catalog()
        .and_then(|c| c.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(|_| "INVALID: this PDF has no page tree".to_string())
}

/// Replaces the page tree with a flat list. Call `bake_inherited` first.
/// Pages left out become unreachable and disappear on `finish`.
pub fn set_page_list(doc: &mut Document, ids: &[ObjectId]) -> Res<()> {
    let root = root_pages_id(doc)?;
    let mut seen = BTreeSet::new();
    let kids: Vec<ObjectId> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
    for id in &kids {
        doc.get_dictionary_mut(*id).map_err(|e| e.to_string())?.set("Parent", Object::Reference(root));
    }
    let mut node = Dictionary::new();
    node.set("Type", "Pages");
    node.set("Count", kids.len() as i64);
    node.set("Kids", kids.iter().map(|id| Object::Reference(*id)).collect::<Vec<_>>());
    doc.objects.insert(root, Object::Dictionary(node));
    drop_dangling_links(doc, &seen);
    Ok(())
}

/// Removes navigation that would keep deleted pages alive or point nowhere:
/// outlines, page labels, named destinations and links to dropped pages.
fn drop_dangling_links(doc: &mut Document, kept: &BTreeSet<ObjectId>) {
    let all_pages: BTreeSet<ObjectId> = doc
        .objects
        .iter()
        .filter(|(_, o)| o.as_dict().map(|d| d.has_type(b"Page")).unwrap_or(false))
        .map(|(id, _)| *id)
        .collect();
    if all_pages.iter().all(|id| kept.contains(id)) {
        return;
    }
    if let Ok(catalog) = doc.catalog_mut() {
        for key in [&b"Outlines"[..], b"PageLabels", b"StructTreeRoot", b"Dests"] {
            catalog.remove(key);
        }
        if let Ok(Object::Dictionary(names)) = catalog.get_mut(b"Names") {
            names.remove(b"Dests");
        }
    }
    for page_id in kept.iter().copied().collect::<Vec<_>>() {
        let annots: Vec<Object> = match doc.get_dictionary(page_id).and_then(|p| p.get(b"Annots")) {
            Ok(Object::Array(a)) => a.clone(),
            Ok(Object::Reference(r)) => doc.get_object(*r).and_then(Object::as_array).cloned().unwrap_or_default(),
            _ => continue,
        };
        let filtered: Vec<Object> = annots
            .into_iter()
            .filter(|annot| {
                let dict = match annot {
                    Object::Reference(r) => doc.get_dictionary(*r).ok(),
                    Object::Dictionary(d) => Some(d),
                    _ => None,
                };
                let Some(dict) = dict else { return true };
                let target = link_target(doc, dict);
                !matches!(target, Some(t) if all_pages.contains(&t) && !kept.contains(&t))
            })
            .collect();
        if let Ok(page) = doc.get_dictionary_mut(page_id) {
            page.set("Annots", filtered);
        }
    }
}

fn link_target(doc: &Document, annot: &Dictionary) -> Option<ObjectId> {
    let dest = annot.get(b"Dest").ok().or_else(|| {
        let action = match annot.get(b"A").ok()? {
            Object::Reference(r) => doc.get_dictionary(*r).ok()?,
            Object::Dictionary(d) => d,
            _ => return None,
        };
        action.get(b"D").ok()
    })?;
    let dest = match dest {
        Object::Reference(r) => doc.get_object(*r).ok()?,
        other => other,
    };
    dest.as_array().ok()?.first()?.as_reference().ok()
}

/// Visible page box and display rotation, used to place stamps on the edge the reader sees.
pub struct PageGeom {
    pub x0: f32,
    pub y0: f32,
    pub w: f32,
    pub h: f32,
    pub rot: i64,
}

impl PageGeom {
    pub fn of(doc: &Document, page_id: ObjectId) -> PageGeom {
        let page = doc.get_dictionary(page_id).ok();
        let rect = |key: &[u8]| -> Option<[f32; 4]> {
            let obj = page?.get(key).ok()?;
            let obj = match obj {
                Object::Reference(r) => doc.get_object(*r).ok()?,
                o => o,
            };
            let a = obj.as_array().ok()?;
            if a.len() != 4 {
                return None;
            }
            let mut out = [0f32; 4];
            for (i, v) in a.iter().enumerate() {
                out[i] = v.as_float().ok()?;
            }
            Some(out)
        };
        let r = rect(b"CropBox").or_else(|| rect(b"MediaBox")).unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let (x0, x1) = (r[0].min(r[2]), r[0].max(r[2]));
        let (y0, y1) = (r[1].min(r[3]), r[1].max(r[3]));
        let rot = page
            .and_then(|p| p.get(b"Rotate").ok())
            .and_then(|o| o.as_i64().ok())
            .unwrap_or(0)
            .rem_euclid(360);
        PageGeom { x0, y0, w: x1 - x0, h: y1 - y0, rot: rot - rot % 90 }
    }

    /// Width and height as displayed.
    pub fn visual(&self) -> (f32, f32) {
        if self.rot == 90 || self.rot == 270 { (self.h, self.w) } else { (self.w, self.h) }
    }

    /// Matrix that maps upright, displayed coordinates starting at (vx, vy) into user space.
    pub fn place(&self, vx: f32, vy: f32) -> [f32; 6] {
        let (x0, y0, w, h) = (self.x0, self.y0, self.w, self.h);
        match self.rot {
            90 => [0.0, 1.0, -1.0, 0.0, x0 + w - vy, y0 + vx],
            180 => [-1.0, 0.0, 0.0, -1.0, x0 + w - vx, y0 + h - vy],
            270 => [0.0, -1.0, 1.0, 0.0, x0 + vy, y0 + h - vx],
            _ => [1.0, 0.0, 0.0, 1.0, x0 + vx, y0 + vy],
        }
    }
}

/// Adds `name -> target` to a page's resource category (Font, XObject, ExtGState),
/// following indirect dictionaries so shared resources stay shared.
pub fn add_resource(doc: &mut Document, page_id: ObjectId, cat: &[u8], name: &[u8], target: ObjectId) -> Res<()> {
    let e = |e: lopdf::Error| e.to_string();
    let res_ref = match doc.get_dictionary(page_id).map_err(e)?.get(b"Resources") {
        Ok(Object::Reference(r)) => Some(*r),
        Ok(Object::Dictionary(_)) => None,
        _ => {
            doc.get_dictionary_mut(page_id).map_err(e)?.set("Resources", Dictionary::new());
            None
        }
    };
    let cat_ref = {
        let res = match res_ref {
            Some(r) => doc.get_dictionary(r).map_err(e)?,
            None => doc.get_dictionary(page_id).map_err(e)?.get(b"Resources").and_then(Object::as_dict).map_err(e)?,
        };
        match res.get(cat) {
            Ok(Object::Reference(r)) => Some(*r),
            _ => None,
        }
    };
    if let Some(c) = cat_ref {
        doc.get_dictionary_mut(c).map_err(e)?.set(name, target);
        return Ok(());
    }
    let res = match res_ref {
        Some(r) => doc.get_dictionary_mut(r).map_err(e)?,
        None => doc
            .get_dictionary_mut(page_id)
            .map_err(e)?
            .get_mut(b"Resources")
            .and_then(Object::as_dict_mut)
            .map_err(e)?,
    };
    if !matches!(res.get(cat), Ok(Object::Dictionary(_))) {
        res.set(cat, Dictionary::new());
    }
    res.get_mut(cat).and_then(Object::as_dict_mut).map_err(e)?.set(name, target);
    Ok(())
}

/// Draws `overlay` on top of a page, isolating it from the page's own graphics state.
pub fn overlay_content(doc: &mut Document, page_id: ObjectId, overlay: Vec<u8>) -> Res<()> {
    let existing: Vec<Object> = match doc.get_dictionary(page_id).map_err(|e| e.to_string())?.get(b"Contents") {
        Ok(Object::Reference(r)) => match doc.get_object(*r) {
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![Object::Reference(*r)],
        },
        Ok(Object::Array(a)) => a.clone(),
        _ => vec![],
    };
    let mut contents = Vec::with_capacity(existing.len() + 2);
    if existing.is_empty() {
        contents.push(Object::Reference(doc.add_object(lopdf::Stream::new(Dictionary::new(), overlay))));
    } else {
        let open = doc.add_object(lopdf::Stream::new(Dictionary::new(), b"q\n".to_vec()));
        let mut body = b"\nQ\n".to_vec();
        body.extend(overlay);
        let close = doc.add_object(lopdf::Stream::new(Dictionary::new(), body));
        contents.push(Object::Reference(open));
        contents.extend(existing);
        contents.push(Object::Reference(close));
    }
    doc.get_dictionary_mut(page_id).map_err(|e| e.to_string())?.set("Contents", contents);
    Ok(())
}
