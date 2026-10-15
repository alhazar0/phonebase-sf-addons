#!/usr/bin/env swift

import AppKit
import Foundation
import Vision

struct PixelPoint: Codable {
    let x: Double
    let y: Double
}

struct ScreenRectangle: Codable {
    let confidence: Float
    let topLeft: PixelPoint
    let topRight: PixelPoint
    let bottomRight: PixelPoint
    let bottomLeft: PixelPoint
    let areaRatio: Double
}

struct ScreenDetectionOutput: Codable {
    let ok: Bool
    let imageWidth: Int
    let imageHeight: Int
    let elapsedMs: Int
    let candidates: [ScreenRectangle]
}

func fail(_ message: String, status: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(status)
}

func pixelPoint(_ point: CGPoint, width: Int, height: Int) -> PixelPoint {
    PixelPoint(
        x: point.x * Double(width),
        y: (1 - point.y) * Double(height)
    )
}

func polygonArea(_ points: [PixelPoint]) -> Double {
    guard points.count >= 3 else { return 0 }
    var twiceArea = 0.0
    for index in points.indices {
        let next = points[(index + 1) % points.count]
        twiceArea += points[index].x * next.y - next.x * points[index].y
    }
    return abs(twiceArea) / 2
}

guard CommandLine.arguments.count == 2 else {
    fail("Usage: vision-screen.swift <image-path>")
}

let startedAt = DispatchTime.now().uptimeNanoseconds
let imagePath = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: imagePath) else {
    fail("Unable to load image: \(imagePath)")
}
var proposedRect = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
    fail("Unable to decode image: \(imagePath)")
}

let request = VNDetectRectanglesRequest()
request.maximumObservations = 24
request.minimumConfidence = 0.25
request.minimumAspectRatio = 0.20
request.maximumAspectRatio = 1.0
request.minimumSize = 0.12
request.quadratureTolerance = 40

do {
    try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([request])
} catch {
    fail("Vision screen detection failed: \(error.localizedDescription)")
}

let imageWidth = cgImage.width
let imageHeight = cgImage.height
let imageArea = Double(imageWidth * imageHeight)
let candidates = (request.results ?? []).map { observation -> ScreenRectangle in
    let topLeft = pixelPoint(observation.topLeft, width: imageWidth, height: imageHeight)
    let topRight = pixelPoint(observation.topRight, width: imageWidth, height: imageHeight)
    let bottomRight = pixelPoint(observation.bottomRight, width: imageWidth, height: imageHeight)
    let bottomLeft = pixelPoint(observation.bottomLeft, width: imageWidth, height: imageHeight)
    let area = polygonArea([topLeft, topRight, bottomRight, bottomLeft])
    return ScreenRectangle(
        confidence: observation.confidence,
        topLeft: topLeft,
        topRight: topRight,
        bottomRight: bottomRight,
        bottomLeft: bottomLeft,
        areaRatio: imageArea > 0 ? area / imageArea : 0
    )
}.sorted {
    if abs($0.areaRatio - $1.areaRatio) > 0.001 {
        return $0.areaRatio > $1.areaRatio
    }
    return $0.confidence > $1.confidence
}

let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
let output = ScreenDetectionOutput(
    ok: true,
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    elapsedMs: elapsedMs,
    candidates: candidates
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
guard let data = try? encoder.encode(output) else {
    fail("Unable to encode screen detection result")
}
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
