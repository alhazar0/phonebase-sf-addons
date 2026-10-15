#!/usr/bin/env swift

import AppKit
import Foundation
import Vision

struct OcrRequest: Decodable {
    let id: String
    let mode: String
    let imageBase64: String
}

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

struct OcrResult: Codable {
    let ok: Bool
    let imageWidth: Int
    let imageHeight: Int
    let elapsedMs: Int
    let items: [RecognizedText]
}

struct OcrResponse: Encodable {
    let id: String
    let result: OcrResult?
    let error: String?
}

let decoder = JSONDecoder()
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]

func writeResponse(_ response: OcrResponse) {
    guard let data = try? encoder.encode(response) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func recognize(_ request: OcrRequest) throws -> OcrResult {
    guard ["fast", "accurate", "literal"].contains(request.mode) else {
        throw NSError(domain: "ScreenHandVision", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Recognition mode must be fast, accurate or literal",
        ])
    }
    guard
        let bytes = Data(base64Encoded: request.imageBase64),
        let image = NSImage(data: bytes)
    else {
        throw NSError(domain: "ScreenHandVision", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Unable to decode image bytes",
        ])
    }
    var proposedRect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
        throw NSError(domain: "ScreenHandVision", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "Unable to create image raster",
        ])
    }

    let startedAt = DispatchTime.now().uptimeNanoseconds
    let visionRequest = VNRecognizeTextRequest()
    visionRequest.recognitionLevel = request.mode == "fast" ? .fast : .accurate
    visionRequest.usesLanguageCorrection = request.mode == "accurate"
    visionRequest.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant"]
    visionRequest.minimumTextHeight = 0.008
    try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([visionRequest])

    let imageWidth = cgImage.width
    let imageHeight = cgImage.height
    let items = (visionRequest.results ?? []).compactMap { observation -> RecognizedText? in
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
    return OcrResult(
        ok: true,
        imageWidth: imageWidth,
        imageHeight: imageHeight,
        elapsedMs: elapsedMs,
        items: items
    )
}

while let line = readLine() {
    autoreleasepool {
        do {
            let request = try decoder.decode(OcrRequest.self, from: Data(line.utf8))
            do {
                writeResponse(OcrResponse(id: request.id, result: try recognize(request), error: nil))
            } catch {
                writeResponse(OcrResponse(
                    id: request.id,
                    result: nil,
                    error: error.localizedDescription
                ))
            }
        } catch {
            writeResponse(OcrResponse(
                id: "invalid-request",
                result: nil,
                error: "Invalid OCR request: \(error.localizedDescription)"
            ))
        }
    }
}
