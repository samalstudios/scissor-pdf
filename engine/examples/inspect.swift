// Opens PDFs with Apple's PDFKit and renders page 1 to PNG, as an independent check
// that engine output is readable: swift inspect.swift [--password pw] file.pdf...
import AppKit
import PDFKit

var args = Array(CommandLine.arguments.dropFirst())
var password: String?
if args.first == "--password" { password = args[1]; args.removeFirst(2) }

for path in args {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
        print("\(path): FAILED TO OPEN"); continue
    }
    if doc.isLocked, let pw = password { _ = doc.unlock(withPassword: pw) }
    var info = "\(path): pages=\(doc.pageCount) encrypted=\(doc.isEncrypted) locked=\(doc.isLocked)"
    if let page = doc.page(at: 0) {
        let box = page.bounds(for: .cropBox)
        info += " size=\(Int(box.width))x\(Int(box.height)) rotate=\(page.rotation)"
        let text = (page.string ?? "").replacingOccurrences(of: "\n", with: " ")
        info += " text=\"\(text.prefix(40))…\(text.suffix(25))\""
        let img = page.thumbnail(of: NSSize(width: 500, height: 500), for: .cropBox)
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path + ".png"))
        }
    }
    print(info)
}
