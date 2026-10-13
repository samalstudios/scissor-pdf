//! Scissor PDF engine: every PDF operation the site offers, compiled to WebAssembly
//! and run in the visitor's browser. Nothing here performs I/O.

pub mod compress;
pub mod edit;
pub mod images;
pub mod ops;
pub mod pages;
pub mod security;
pub mod stamp;
pub mod zip;

use wasm_bindgen::prelude::*;

pub type Res<T> = Result<T, String>;

fn js<T>(r: Res<T>) -> Result<T, JsError> {
    r.map_err(|e| JsError::new(&e))
}

#[wasm_bindgen(js_name = pageCount)]
pub fn page_count(pdf: &[u8]) -> Result<u32, JsError> {
    js(ops::page_count(pdf))
}

#[wasm_bindgen]
pub fn merge(files: js_sys::Array) -> Result<Vec<u8>, JsError> {
    let files: Vec<Vec<u8>> = files.iter().map(|f| js_sys::Uint8Array::new(&f).to_vec()).collect();
    js(ops::merge(&files))
}

/// `pages` are 1-based page numbers in the new order; `rotations` add clockwise degrees per entry.
#[wasm_bindgen]
pub fn organize(pdf: &[u8], pages: &[u32], rotations: &[i32]) -> Result<Vec<u8>, JsError> {
    js(ops::organize(pdf, pages, rotations))
}

/// `pages` holds every group back to back; `lengths` says how many pages each group has.
#[wasm_bindgen]
pub fn split(pdf: &[u8], pages: &[u32], lengths: &[u32], base_name: &str) -> Result<Vec<u8>, JsError> {
    let mut groups = Vec::with_capacity(lengths.len());
    let mut at = 0usize;
    for len in lengths {
        let end = (at + *len as usize).min(pages.len());
        groups.push(pages[at..end].to_vec());
        at = end;
    }
    js(ops::split(pdf, &groups, base_name))
}

#[wasm_bindgen]
pub fn compress(pdf: &[u8], level: u8) -> Result<Vec<u8>, JsError> {
    js(compress::compress(pdf, level))
}

#[wasm_bindgen(js_name = pageNumbers)]
pub fn page_numbers(
    pdf: &[u8],
    position: &str,
    template: &str,
    start: u32,
    first_page: u32,
    size: f32,
    margin: f32,
) -> Result<Vec<u8>, JsError> {
    js(stamp::page_numbers(pdf, &stamp::NumberOptions { position, template, start, first_page, size, margin }))
}

#[wasm_bindgen]
pub fn watermark(
    pdf: &[u8],
    rgba: &[u8],
    width: u32,
    height: u32,
    scale: f32,
    rotation: f32,
    opacity: f32,
    tiled: bool,
) -> Result<Vec<u8>, JsError> {
    js(stamp::watermark(pdf, rgba, width, height, &stamp::WatermarkOptions { scale, rotation, opacity, tiled }))
}

#[wasm_bindgen]
pub fn protect(pdf: &[u8], user_password: &str, owner_password: &str, allow_print: bool, allow_copy: bool) -> Result<Vec<u8>, JsError> {
    js(security::protect(pdf, user_password, owner_password, allow_print, allow_copy))
}

#[wasm_bindgen]
pub fn unlock(pdf: &[u8], password: &str) -> Result<Vec<u8>, JsError> {
    js(security::unlock(pdf, password))
}

#[wasm_bindgen]
pub struct ImageDoc(Option<images::ImagesToPdf>);

#[wasm_bindgen]
impl ImageDoc {
    #[wasm_bindgen(constructor)]
    pub fn new(paper: &str, margin: f32) -> ImageDoc {
        ImageDoc(Some(images::ImagesToPdf::new(paper, margin)))
    }

    #[wasm_bindgen(js_name = addJpeg)]
    pub fn add_jpeg(&mut self, data: &[u8]) -> Result<(), JsError> {
        js(self.inner()?.add_jpeg(data))
    }

    #[wasm_bindgen(js_name = addRgba)]
    pub fn add_rgba(&mut self, rgba: &[u8], width: u32, height: u32) -> Result<(), JsError> {
        js(self.inner()?.add_rgba(rgba, width, height))
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        js(self.0.take().ok_or_else(|| "INVALID: already finished".to_string()).and_then(|d| d.finish()))
    }

    fn inner(&mut self) -> Result<&mut images::ImagesToPdf, JsError> {
        self.0.as_mut().ok_or_else(|| JsError::new("INVALID: already finished"))
    }
}

/// Packs several outputs (for example page images) into one download.
#[wasm_bindgen]
pub struct Zip(Option<zip::ZipWriter>);

#[wasm_bindgen]
impl Zip {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Zip {
        Zip(Some(zip::ZipWriter::default()))
    }

    pub fn add(&mut self, name: &str, data: &[u8]) {
        if let Some(z) = self.0.as_mut() {
            z.add(name, data);
        }
    }

    pub fn finish(&mut self) -> Vec<u8> {
        self.0.take().map(zip::ZipWriter::finish).unwrap_or_default()
    }
}

impl Default for Zip {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub fn crop(pdf: &[u8], pages: &[u32], left: f32, top: f32, right: f32, bottom: f32) -> Result<Vec<u8>, JsError> {
    js(edit::crop(pdf, pages, [left, top, right, bottom]))
}

#[wasm_bindgen(js_name = nUp)]
pub fn n_up(pdf: &[u8], per_sheet: u32, paper: &str) -> Result<Vec<u8>, JsError> {
    js(edit::n_up(pdf, per_sheet, paper))
}

/// `pages[i]` and `rects[4i..4i+4]` (x, y, w, h as fractions of the visible page, from the
/// top-left) place `images[i]`, an RGBA buffer of `sizes[2i] x sizes[2i+1]` pixels.
#[wasm_bindgen(js_name = placeImages)]
pub fn place_images(pdf: &[u8], pages: &[u32], rects: &[f32], sizes: &[u32], images: js_sys::Array) -> Result<Vec<u8>, JsError> {
    let items: Vec<edit::Placement> = images
        .iter()
        .enumerate()
        .map(|(i, img)| edit::Placement {
            page: pages[i],
            rect: [rects[4 * i], rects[4 * i + 1], rects[4 * i + 2], rects[4 * i + 3]],
            rgba: js_sys::Uint8Array::new(&img).to_vec(),
            width: sizes[2 * i],
            height: sizes[2 * i + 1],
        })
        .collect();
    js(edit::place_images(pdf, &items))
}

#[wasm_bindgen]
pub fn metadata(pdf: &[u8], title: &str, author: &str, subject: &str, keywords: &str, wipe: bool) -> Result<Vec<u8>, JsError> {
    js(edit::metadata(pdf, &[("Title", title), ("Author", author), ("Subject", subject), ("Keywords", keywords)], wipe))
}

#[wasm_bindgen]
pub fn repair(pdf: &[u8]) -> Result<Vec<u8>, JsError> {
    js(edit::repair(pdf).map(|(bytes, _)| bytes))
}
