import Foundation
import os

/// stdout, one whole record at a time. The Daemon hanging up ends this process.
final class Output: Sendable {
  private let lock = OSAllocatedUnfairLock()

  func write(_ record: Record) {
    let data = record.encoded
    lock.withLock {
      do {
        try FileHandle.standardOutput.write(contentsOf: data)
      } catch {
        exit(0)
      }
    }
  }
}
