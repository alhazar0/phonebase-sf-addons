#!/usr/bin/env swift

import AppKit
import Foundation
import simd
import Vision

struct RegistrationOutput: Codable {
    let ok: Bool
    let confidence: Float
    let elapsedMs: Int
    let referenceWidth: Int
    let referenceHeight: Int
    let currentWidth: Int
    let currentHeight: Int
    let referenceToCurrentVision: [Double]
}

func fail(_ message: String, status: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(status)
}

func loadImage(_ path: String) -> CGImage {
    guard let image = NSImage(contentsOfFile: path) else {
        fail("Unable to load image: \(path)")
    }
    var proposedRect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
        fail("Unable to decode image: \(path)")
    }
    return cgImage
}

guard CommandLine.arguments.count == 3 else {
    fail("Usage: vision-register.swift <reference-image> <current-image>")
}

let startedAt = DispatchTime.now().uptimeNanoseconds
let reference = loadImage(CommandLine.arguments[1])
let current = loadImage(CommandLine.arguments[2])
guard reference.width == current.width, reference.height == current.height else {
    fail("Reference and current frames must have identical dimensions")
}

let request = VNHomographicImageRegistrationRequest(targetedCGImage: reference)
do {
    try VNImageRequestHandler(cgImage: current, orientation: .up).perform([request])
} catch {
    fail("Vision image registration failed: \(error.localizedDescription)")
}
guard let observation = request.results?.first else {
    fail("Vision could not register the current frame to the saved reference")
}
let matrix = observation.warpTransform
let rowMajor = [
    Double(matrix.columns.0.x), Double(matrix.columns.1.x), Double(matrix.columns.2.x),
    Double(matrix.columns.0.y), Double(matrix.columns.1.y), Double(matrix.columns.2.y),
    Double(matrix.columns.0.z), Double(matrix.columns.1.z), Double(matrix.columns.2.z),
]
let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
let output = RegistrationOutput(
    ok: true,
    confidence: observation.confidence,
    elapsedMs: elapsedMs,
    referenceWidth: reference.width,
    referenceHeight: reference.height,
    currentWidth: current.width,
    currentHeight: current.height,
    referenceToCurrentVision: rowMajor
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
guard let data = try? encoder.encode(output) else {
    fail("Unable to encode registration result")
}
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
