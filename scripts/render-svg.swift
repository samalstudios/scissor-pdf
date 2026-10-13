// Renders an SVG file to a PNG of the given size with AppKit: swift render-svg.swift in.svg out.png width height
import AppKit
let a = CommandLine.arguments
let (w, h) = (Int(a[3])!, Int(a[4])!)
guard let img = NSImage(contentsOfFile: a[1]) else { fatalError("cannot load \(a[1])") }
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
img.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
