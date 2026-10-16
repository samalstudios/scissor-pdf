//! End-to-end checks for every engine operation, on PDFs generated here.
//! Pages are told apart by their width (100 + 10 × page number points).

use engine::{compress, edit, images, more, ops, security, stamp};
use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, Stream, dictionary};

/// A document with `n` pages of different widths, each with a line of text.
fn sample(n: u32) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
    let mut kids = Vec::new();
    for i in 1..=n {
        let ops = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![20.into(), 400.into()]),
            Operation::new("Tj", vec![Object::string_literal(format!("Page {i}"))]),
            Operation::new("ET", vec![]),
        ];
        let content = doc.add_object(Stream::new(dictionary! {}, Content { operations: ops }.encode().unwrap()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content,
            "MediaBox" => vec![0.into(), 0.into(), (100 + 10 * i as i64).into(), 500.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });
        kids.push(Object::Reference(page));
    }
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => n as i64 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn open(bytes: &[u8]) -> Document {
    Document::load_mem(bytes).expect("output must be a readable PDF")
}

/// Visible page widths in order, which identify the original pages.
fn widths(bytes: &[u8]) -> Vec<i64> {
    let doc = open(bytes);
    doc.get_pages()
        .values()
        .map(|id| {
            let page = doc.get_dictionary(*id).unwrap();
            let bx = page.get(b"CropBox").or_else(|_| page.get(b"MediaBox")).unwrap().as_array().unwrap();
            (bx[2].as_float().unwrap() - bx[0].as_float().unwrap()).round() as i64
        })
        .collect()
}

fn pages(bytes: &[u8]) -> usize {
    open(bytes).get_pages().len()
}

fn zip_entries(bytes: &[u8]) -> usize {
    assert_eq!(&bytes[..4], b"PK\x03\x04");
    bytes.windows(4).filter(|w| *w == b"PK\x01\x02").count()
}

#[test]
fn merge_keeps_order_and_pages() {
    let out = ops::merge(&[sample(2), sample(3)]).unwrap();
    assert_eq!(widths(&out), vec![110, 120, 110, 120, 130]);
}

#[test]
fn organize_reorders_rotates_and_drops() {
    let out = ops::organize(&sample(4), &[3, 1], &[90, 0]).unwrap();
    assert_eq!(widths(&out), vec![130, 110]);
    let doc = open(&out);
    let first = doc.get_dictionary(*doc.get_pages().get(&1).unwrap()).unwrap();
    assert_eq!(first.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
}

#[test]
fn split_makes_one_file_per_group() {
    assert_eq!(zip_entries(&ops::split(&sample(5), &[vec![1, 2], vec![3], vec![4, 5]], "p").unwrap()), 3);
    assert_eq!(pages(&ops::split(&sample(5), &[vec![2, 4]], "p").unwrap()), 2);
}

#[test]
fn compress_produces_a_valid_pdf_at_every_level() {
    for level in 0..=2 {
        assert_eq!(pages(&compress::compress(&sample(3), level).unwrap()), 3);
    }
}

#[test]
fn protect_then_unlock_round_trip() {
    let locked = security::protect(&sample(2), "secret", "", true, true).unwrap();
    assert!(ops::load(&locked).is_err(), "a protected file must not open without the password");
    assert!(security::unlock(&locked, "wrong").is_err());
    assert_eq!(pages(&security::unlock(&locked, "secret").unwrap()), 2);
}

#[test]
fn page_numbers_and_watermark_keep_pages() {
    let numbered = stamp::page_numbers(&sample(3), &stamp::NumberOptions { position: "bottom-center", template: "Página {n} de {total}", start: 1, first_page: 1, size: 11.0, margin: 24.0 }).unwrap();
    assert_eq!(pages(&numbered), 3);
    let rgba = vec![255u8; 8 * 4 * 4];
    let marked = stamp::watermark(&sample(2), &rgba, 8, 4, &stamp::WatermarkOptions { scale: 0.5, rotation: 45.0, opacity: 0.3, tiled: true }).unwrap();
    assert_eq!(pages(&marked), 2);
}

#[test]
fn images_become_pages() {
    let mut doc = images::ImagesToPdf::new("a4", 20.0);
    doc.add_rgba(&vec![200u8; 10 * 10 * 4], 10, 10).unwrap();
    doc.add_rgba(&vec![50u8; 20 * 10 * 4], 20, 10).unwrap();
    assert_eq!(pages(&doc.finish().unwrap()), 2);
}

#[test]
fn crop_sets_a_smaller_visible_area() {
    let out = edit::crop(&sample(1), &[], [0.1, 0.0, 0.1, 0.0]).unwrap();
    assert_eq!(widths(&out), vec![88]);
}

#[test]
fn layouts_change_page_counts() {
    assert_eq!(pages(&edit::n_up(&sample(5), 2, "a4").unwrap()), 3);
    assert_eq!(pages(&edit::n_up(&sample(5), 4, "a4").unwrap()), 2);
    assert_eq!(pages(&more::booklet(&sample(5), "a4").unwrap()), 4);
    assert_eq!(pages(&more::resize(&sample(3), "letter").unwrap()), 3);
}

#[test]
fn page_tools_add_and_cut_pages() {
    assert_eq!(pages(&more::insert_blank(&sample(3), &[], true).unwrap()), 6);
    assert_eq!(pages(&more::insert_blank(&sample(3), &[0, 2], false).unwrap()), 5);
    assert_eq!(pages(&more::split_half(&sample(3), true, false).unwrap()), 6);
    assert_eq!(widths(&more::add_margins(&sample(1), 10.0).unwrap()), vec![130]);
}

#[test]
fn interleave_alternates_and_reverses_the_second_file() {
    let out = more::interleave(&sample(2), &sample(3), true).unwrap();
    assert_eq!(widths(&out), vec![110, 130, 120, 120, 110]);
}

#[test]
fn bookmarks_round_trip_and_split() {
    let out = more::set_bookmarks(&sample(4), &[("Intro".into(), 1), ("Kurdî ✓".into(), 3)]).unwrap();
    let toc = open(&out).get_toc().unwrap();
    assert_eq!(toc.toc.len(), 2);
    assert_eq!(zip_entries(&more::split_by_bookmarks(&out, "ch").unwrap()), 2);
}

#[test]
fn split_by_size_respects_the_limit() {
    let zip = more::split_by_size(&sample(6), 1_000, "part").unwrap();
    assert!(zip_entries(&zip) >= 2);
}

#[test]
fn metadata_is_set_and_wiped() {
    let set = edit::metadata(&sample(1), &[("Title", "Rapport ✓"), ("Author", "Sia")], false).unwrap();
    assert!(more::info(&set).unwrap().contains("Rapport ✓"));
    let wiped = edit::metadata(&set, &[], true).unwrap();
    assert!(open(&wiped).trailer.get(b"Info").is_err());
}

#[test]
fn placed_images_backgrounds_and_cleanups_keep_pages() {
    let item = edit::Placement { page: 2, rect: [0.1, 0.1, 0.3, 0.1], rgba: vec![0u8; 4 * 4 * 4], width: 4, height: 4 };
    assert_eq!(pages(&edit::place_images(&sample(3), &[item]).unwrap()), 3);
    assert_eq!(pages(&more::add_background(&sample(3), &sample(1), false, false).unwrap()), 3);
    assert_eq!(pages(&more::grayscale(&sample(2)).unwrap()), 2);
    assert_eq!(pages(&more::flatten(&sample(2)).unwrap()), 2);
    assert_eq!(pages(&more::remove_annotations(&sample(2), true).unwrap()), 2);
    assert_eq!(pages(&more::remove_images(&sample(2)).unwrap()), 2);
}

#[test]
fn repair_rebuilds_a_file_without_its_index() {
    let good = sample(3);
    let cut = good.windows(4).rposition(|w| w == b"xref").unwrap();
    let (fixed, count) = edit::repair(&good[..cut]).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(count, 3);
    assert_eq!(pages(&fixed), 3);
}

#[test]
fn info_describes_the_file() {
    let json = more::info(&sample(2)).unwrap();
    assert!(json.contains("\"pages\":2"));
    assert!(json.contains("Helvetica"));
}

#[test]
fn not_a_pdf_is_rejected_with_a_code() {
    let err = ops::load(b"hello").unwrap_err();
    assert!(err.starts_with("INVALID"));
}
