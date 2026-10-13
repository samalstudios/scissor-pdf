//! Structural operations: merge, organize (reorder, rotate, delete, extract) and split.

use lopdf::{Dictionary, Document, Object, ObjectId, SaveOptions};

use crate::pages::{bake_inherited, page_ids, set_page_list};
use crate::{Res, zip};

/// Loads a PDF, turning library errors into codes the UI can explain.
pub fn load(bytes: &[u8]) -> Res<Document> {
    if !bytes.windows(5).take(1024).any(|w| w == b"%PDF-") {
        return Err("INVALID: this file is not a PDF".into());
    }
    let doc = Document::load_mem(bytes).map_err(|e| {
        let msg = e.to_string();
        if msg.to_lowercase().contains("password") || msg.to_lowercase().contains("decrypt") {
            "ENCRYPTED: this PDF is password protected. Unlock it first.".to_string()
        } else {
            format!("INVALID: could not read this PDF ({msg})")
        }
    })?;
    if doc.is_encrypted() {
        return Err("ENCRYPTED: this PDF is password protected. Unlock it first.".into());
    }
    Ok(doc)
}

/// Drops unreachable objects and writes the file.
pub fn finish(doc: Document, object_streams: bool) -> Res<Vec<u8>> {
    finish_with(doc, object_streams, true)
}

/// Like `finish`, but can leave the document info untouched (used when wiping metadata).
pub fn finish_with(mut doc: Document, object_streams: bool, stamp_producer: bool) -> Res<Vec<u8>> {
    doc.prune_objects();
    doc.delete_zero_length_streams();
    doc.renumber_objects();
    if stamp_producer {
        doc.change_producer("Scissor PDF (pdf.scissor.studio)");
    }
    let mut out = Vec::new();
    if object_streams {
        let options = SaveOptions::builder().use_object_streams(true).use_xref_streams(true).compression_level(9).build();
        doc.save_with_options(&mut out, options).map_err(|e| e.to_string())?;
    } else {
        doc.save_to(&mut out).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub fn page_count(bytes: &[u8]) -> Res<u32> {
    Ok(load(bytes)?.get_pages().len() as u32)
}

pub fn merge(files: &[Vec<u8>]) -> Res<Vec<u8>> {
    if files.is_empty() {
        return Err("INVALID: add at least one PDF".into());
    }
    let mut out: Option<Document> = None;
    let mut all_pages: Vec<ObjectId> = Vec::new();
    let mut fields: Vec<Object> = Vec::new();
    let mut next_id = 1;
    for (index, bytes) in files.iter().enumerate() {
        let mut doc = load(bytes).map_err(|e| format!("{e} (file {})", index + 1))?;
        bake_inherited(&mut doc);
        doc.renumber_objects_with(next_id);
        next_id = doc.max_id + 1;
        all_pages.extend(page_ids(&doc));
        if let Some(form) = acroform(&doc)
            && let Ok(Object::Array(f)) = form.get(b"Fields")
        {
            fields.extend(f.iter().cloned());
        }
        match out.as_mut() {
            None => out = Some(doc),
            Some(o) => {
                o.objects.extend(doc.objects);
                o.max_id = next_id - 1;
            }
        }
    }
    let mut doc = out.expect("at least one file");
    set_page_list(&mut doc, &all_pages)?;
    if !fields.is_empty() {
        let form_ref = doc.catalog().ok().and_then(|c| c.get(b"AcroForm").ok()).and_then(|o| o.as_reference().ok());
        match form_ref {
            Some(id) => {
                if let Ok(form) = doc.get_dictionary_mut(id) {
                    form.set("Fields", fields);
                }
            }
            None => {
                let mut form = acroform(&doc).cloned().unwrap_or_else(Dictionary::new);
                form.set("Fields", fields);
                doc.catalog_mut().map_err(|e| e.to_string())?.set("AcroForm", form);
            }
        }
    }
    finish(doc, false)
}

fn acroform(doc: &Document) -> Option<&Dictionary> {
    match doc.catalog().ok()?.get(b"AcroForm").ok()? {
        Object::Reference(r) => doc.get_dictionary(*r).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

/// Builds a document from `pages` (1-based, in the new order), adding `rotations[i]`
/// degrees clockwise to each. Used for reorder, rotate, delete and extract.
pub fn organize(bytes: &[u8], pages: &[u32], rotations: &[i32]) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    apply_selection(&mut doc, pages, rotations)?;
    finish(doc, false)
}

fn apply_selection(doc: &mut Document, pages: &[u32], rotations: &[i32]) -> Res<()> {
    let ids = page_ids(doc);
    if pages.is_empty() {
        return Err("INVALID: keep at least one page".into());
    }
    let mut chosen = Vec::with_capacity(pages.len());
    for (i, n) in pages.iter().enumerate() {
        let id = *ids.get((*n as usize).wrapping_sub(1)).ok_or_else(|| format!("INVALID: page {n} does not exist"))?;
        let delta = rotations.get(i).copied().unwrap_or(0);
        if delta % 360 != 0 {
            let page = doc.get_dictionary_mut(id).map_err(|e| e.to_string())?;
            let current = page.get(b"Rotate").and_then(Object::as_i64).unwrap_or(0);
            page.set("Rotate", (current + delta as i64).rem_euclid(360));
        }
        chosen.push(id);
    }
    set_page_list(doc, &chosen)
}

/// Writes one PDF per group of 1-based page numbers and packs them into a zip.
/// A single group returns the PDF itself.
pub fn split(bytes: &[u8], groups: &[Vec<u32>], base: &str) -> Res<Vec<u8>> {
    let mut doc = load(bytes)?;
    bake_inherited(&mut doc);
    if groups.len() == 1 {
        apply_selection(&mut doc, &groups[0], &[])?;
        return finish(doc, false);
    }
    let mut zip = zip::ZipWriter::default();
    for group in groups {
        let mut part = doc.clone();
        apply_selection(&mut part, group, &[])?;
        let name = match (group.first(), group.last()) {
            (Some(a), Some(b)) if a == b => format!("{base}-page-{a}.pdf"),
            (Some(a), Some(b)) => format!("{base}-pages-{a}-{b}.pdf"),
            _ => continue,
        };
        zip.add(&name, &finish(part, false)?);
    }
    Ok(zip.finish())
}
