//! Native harness for exercising the engine on real files:
//! cargo run --release --example cli -- <op> <out> <inputs...>

use std::fs;

use engine::{compress, edit, images, ops, security, stamp};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (op, out, inputs) = (&args[0], &args[1], &args[2..]);
    let read = |i: usize| fs::read(&inputs[i]).expect("read input");
    let result = match op.as_str() {
        "merge" => ops::merge(&inputs.iter().map(|p| fs::read(p).unwrap()).collect::<Vec<_>>()),
        "reverse" => {
            let n = ops::page_count(&read(0)).unwrap();
            let pages: Vec<u32> = (1..=n).rev().collect();
            ops::organize(&read(0), &pages, &vec![90; pages.len()])
        }
        "split" => ops::split(&read(0), &[vec![1], vec![2, 3]], "part"),
        "compress0" => compress::compress(&read(0), 0),
        "compress1" => compress::compress(&read(0), 1),
        "compress2" => compress::compress(&read(0), 2),
        "numbers" => stamp::page_numbers(
            &read(0),
            &stamp::NumberOptions { position: "bottom-center", template: "Page {n} of {total}", start: 1, first_page: 1, size: 11.0, margin: 24.0 },
        ),
        "watermark" => {
            let (w, h) = (64u32, 16u32);
            let rgba: Vec<u8> = (0..w * h).flat_map(|i| [220, 30, 30, if i % 7 == 0 { 0 } else { 255 }]).collect();
            stamp::watermark(&read(0), &rgba, w, h, &stamp::WatermarkOptions { scale: 0.5, rotation: 45.0, opacity: 0.3, tiled: false })
        }
        "images" => {
            let mut d = images::ImagesToPdf::new("a4", 20.0);
            for p in inputs {
                d.add_jpeg(&fs::read(p).unwrap()).unwrap();
            }
            d.finish()
        }
        "protect" => security::protect(&read(0), "secret", "", true, false),
        "unlock" => security::unlock(&read(0), &args[3..].join("")),
        "crop" => edit::crop(&read(0), &[], [0.1, 0.2, 0.1, 0.05]),
        "nup2" => edit::n_up(&read(0), 2, "auto"),
        "nup4" => edit::n_up(&read(0), 4, "a4"),
        "sign" => {
            let (w, h) = (40u32, 20u32);
            let rgba: Vec<u8> = (0..w * h).flat_map(|i| [10, 60, 200, if (i / w + i % w) % 3 == 0 { 255 } else { 0 }]).collect();
            edit::place_images(&read(0), &[edit::Placement { page: 1, rect: [0.6, 0.8, 0.3, 0.1], rgba, width: w, height: h }])
        }
        "meta" => edit::metadata(&read(0), &[("Title", "Ünïcode title ✓"), ("Author", "Sia")], false),
        "wipe" => edit::metadata(&read(0), &[], true),
        "repair" => edit::repair(&read(0)).map(|(b, _)| b),
        _ => panic!("unknown op"),
    };
    match result {
        Ok(bytes) => {
            fs::write(out, &bytes).unwrap();
            println!("{op}: {} bytes", bytes.len());
        }
        Err(e) => println!("{op}: ERROR {e}"),
    }
}
