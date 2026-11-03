package dev.lux.polaris.sodium;

import java.nio.ByteBuffer;

final class Sodium {
  static {
    System.loadLibrary("polaris_sodium");
  }

  private Sodium() {}

  static void initialize() {}

  static native void randombytesBuf(ByteBuffer buffer);
  static native void hashSha256(ByteBuffer out, ByteBuffer input);
  static native void signKeypair(ByteBuffer pk, ByteBuffer sk);
  static native void signSeedKeypair(ByteBuffer pk, ByteBuffer sk, ByteBuffer seed);
  static native void signDetached(ByteBuffer signature, ByteBuffer message, ByteBuffer sk);
  static native void kxKeypair(ByteBuffer pk, ByteBuffer sk);
  static native void kxSeedKeypair(ByteBuffer pk, ByteBuffer sk, ByteBuffer seed);
  static native void scalarmult(ByteBuffer out, ByteBuffer sk, ByteBuffer pk);
  static native void scalarmultBase(ByteBuffer out, ByteBuffer sk);
  static native int encrypt(ByteBuffer out, ByteBuffer message, ByteBuffer ad, ByteBuffer nonce, ByteBuffer key);
  static native int decrypt(ByteBuffer out, ByteBuffer ciphertext, ByteBuffer ad, ByteBuffer nonce, ByteBuffer key);
  static native void generichash(ByteBuffer out, ByteBuffer input, ByteBuffer key);
}
