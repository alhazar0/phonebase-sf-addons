#!/usr/bin/env swift

import AppKit
import Foundation
import Vision

struct RecognizedText: Codable {
    let text: String
    let confidence: Float
    let left: Double
    let top: Double
    let width: Double
    let height: Double
    let centerX: Double
    let centerY: Double
}

struct OcrOutput: Codable {
    let ok: Bool
    let imageWidth: Int
    let imageHeight: Int
    let elapsedMs: Int
    let items: [RecognizedText]
}

func fail(_ message: String, status: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(status)
}

guard CommandLine.arguments.count == 3 else {
    fail("Usage: vision-ocr.swift <fast|accurate|literal> <image-path>")
}

let startedAt = DispatchTime.now().uptimeNanoseconds
let recognitionMode = CommandLine.arguments[1]
guard ["fast", "accurate", "literal"].contains(recognitionMode) else {
    fail("Recognition mode must be fast, accurate or literal")
}
let imagePath = CommandLine.arguments[2]
guard let image = NSImage(contentsOfFile: imagePath) else {
    fail("Unable to load image: \(imagePath)")
}
var proposedRect = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
    fail("Unable to decode image: \(imagePath)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
request.usesLanguageCorrection = recognitionMode == "accurate"
request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant"]
request.minimumTextHeight = 0.008

do {
    try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([request])
} catch {
    fail("Vision OCR failed: \(error.localizedDescription)")
}

let imageWidth = cgImage.width
let imageHeight = cgImage.height
let items = (request.results ?? []).compactMap { observation -> RecognizedText? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    let left = box.minX * Double(imageWidth)
    let top = (1 - box.maxY) * Double(imageHeight)
    let width = box.width * Double(imageWidth)
    let height = box.height * Double(imageHeight)
    return RecognizedText(
        text: candidate.string,
        confidence: candidate.confidence,
        left: left,
        top: top,
        width: width,
        height: height,
        centerX: left + width / 2,
        centerY: top + height / 2
    )
}.sorted {
    if abs($0.top - $1.top) > 8 { return $0.top < $1.top }
    return $0.left < $1.left
}

let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
let output = OcrOutput(
    ok: true,
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    elapsedMs: elapsedMs,
    items: items
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
guard let data = try? encoder.encode(output) else {
    fail("Unable to encode OCR result")
}
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
