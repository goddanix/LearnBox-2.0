// vision-ocr — text recognition with Apple's Vision framework (macOS), for labels inside raster figures.
//
// Usage: vision-ocr <image.png> [minConfidence]
// Prints one JSON array on stdout: [{ text, conf, bbox:[x0,y0,x1,y1], words:[{ t, bbox }] }, …]
// Boxes are normalised to the image, origin TOP LEFT. `bbox` covers only the cleaned text (border marks such
// as "•" — often a colour swatch or bullet — are cut off); `words` lists the words singly, so a legend
// entry's number or swatch can be told from its name.
//
// A port of MedAnki's medanki/ocr.py (PyObjC) — same recognition level, languages and clean-up.

import Foundation
import ImageIO
import Vision

let strip: Set<Character> = [" ", "-", "–", "—", "~", "|", "_", "•", "·", ":", ";", "'", "\""]

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let args = CommandLine.arguments
if args.count < 2 { fail("usage: vision-ocr <image.png> [minConfidence]") }
let minConf: Float = args.count > 2 ? (Float(args[2]) ?? 0.4) : 0.4

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("cannot read image: \(args[1])")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["de-DE", "en-US"]
request.usesLanguageCorrection = true

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fail("recognition failed: \(error)")
}

func round4(_ v: CGFloat) -> Double { (Double(v) * 10000).rounded() / 10000 }

/// Box of a character range of a candidate, as [x0, y0, x1, y1] with origin top left.
func box(_ candidate: VNRecognizedText, _ range: Range<String.Index>) -> [Double]? {
    guard let rect = try? candidate.boundingBox(for: range)?.boundingBox else { return nil }
    return [round4(rect.minX), round4(1 - rect.maxY), round4(rect.maxX), round4(1 - rect.minY)]
}

var out: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let original = candidate.string
    let raw = original.trimmingCharacters(in: .whitespacesAndNewlines)
    // character offset of `raw` inside `original`, for the candidate's range lookups
    let wsLead = original.prefix { $0.isWhitespace }.count
    // guide lines and arrows next to a label are often read as border characters
    let chars = Array(raw)
    var lo = 0
    var hi = chars.count
    while lo < hi && strip.contains(chars[lo]) { lo += 1 }
    while hi > lo && strip.contains(chars[hi - 1]) { hi -= 1 }
    let cleaned = lo < hi ? String(chars[lo..<hi]) : raw
    let trimmed = lo < hi
    let conf = candidate.confidence
    if cleaned.isEmpty || conf < minConf { continue }

    let start = original.startIndex
    var bbox: [Double]
    if trimmed && (lo > 0 || hi < chars.count),
       let tight = box(candidate, original.index(start, offsetBy: wsLead + lo)..<original.index(start, offsetBy: wsLead + hi)) {
        bbox = tight
    } else {
        let r = observation.boundingBox
        bbox = [round4(r.minX), round4(1 - r.maxY), round4(r.maxX), round4(1 - r.minY)]
    }

    var words: [[String: Any]] = []
    if cleaned.count >= 2 {
        let offset = wsLead + (trimmed ? lo : 0)
        var index = 0
        var taken = 0
        let cleanedChars = Array(cleaned)
        while index < cleanedChars.count && taken < 12 {
            if cleanedChars[index].isWhitespace { index += 1; continue }
            var end = index
            while end < cleanedChars.count && !cleanedChars[end].isWhitespace { end += 1 }
            let word = String(cleanedChars[index..<end])
            if let b = box(candidate, original.index(start, offsetBy: offset + index)..<original.index(start, offsetBy: offset + end)) {
                words.append(["t": word, "bbox": b])
            }
            taken += 1
            index = end
        }
    }
    out.append(["text": cleaned, "conf": (Double(conf) * 100).rounded() / 100, "bbox": bbox, "words": words])
}

let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
