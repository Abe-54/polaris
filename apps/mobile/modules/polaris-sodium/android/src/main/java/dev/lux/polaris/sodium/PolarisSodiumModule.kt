package dev.lux.polaris.sodium

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array

class SodiumException(message: String) : CodedException(message)

class PolarisSodiumModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PolarisSodium")

    OnCreate { Sodium.initialize() }

    Function("randombytes_buf") { buffer: Uint8Array ->
      Sodium.randombytesBuf(buffer.toDirectBuffer())
    }

    Function("crypto_hash_sha256") { out: Uint8Array, input: Uint8Array ->
      Sodium.hashSha256(out.toDirectBuffer(), input.toDirectBuffer())
    }

    Function("crypto_sign_keypair") { pk: Uint8Array, sk: Uint8Array ->
      Sodium.signKeypair(pk.toDirectBuffer(), sk.toDirectBuffer())
    }

    Function("crypto_sign_seed_keypair") { pk: Uint8Array, sk: Uint8Array, seed: Uint8Array ->
      Sodium.signSeedKeypair(pk.toDirectBuffer(), sk.toDirectBuffer(), seed.toDirectBuffer())
    }

    Function("crypto_sign_detached") { signature: Uint8Array, message: Uint8Array, sk: Uint8Array ->
      Sodium.signDetached(signature.toDirectBuffer(), message.toDirectBuffer(), sk.toDirectBuffer())
    }

    Function("crypto_kx_keypair") { pk: Uint8Array, sk: Uint8Array ->
      Sodium.kxKeypair(pk.toDirectBuffer(), sk.toDirectBuffer())
    }

    Function("crypto_kx_seed_keypair") { pk: Uint8Array, sk: Uint8Array, seed: Uint8Array ->
      Sodium.kxSeedKeypair(pk.toDirectBuffer(), sk.toDirectBuffer(), seed.toDirectBuffer())
    }

    Function("crypto_scalarmult") { out: Uint8Array, sk: Uint8Array, pk: Uint8Array ->
      Sodium.scalarmult(out.toDirectBuffer(), sk.toDirectBuffer(), pk.toDirectBuffer())
    }

    Function("crypto_scalarmult_base") { out: Uint8Array, sk: Uint8Array ->
      Sodium.scalarmultBase(out.toDirectBuffer(), sk.toDirectBuffer())
    }

    Function("crypto_aead_chacha20poly1305_ietf_encrypt") {
        out: Uint8Array, message: Uint8Array, ad: Uint8Array, nonce: Uint8Array, key: Uint8Array ->
      Sodium.encrypt(
        out.toDirectBuffer(), message.toDirectBuffer(), ad.toDirectBuffer(),
        nonce.toDirectBuffer(), key.toDirectBuffer()
      )
    }

    Function("crypto_aead_chacha20poly1305_ietf_decrypt") {
        out: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array, nonce: Uint8Array, key: Uint8Array ->
      Sodium.decrypt(
        out.toDirectBuffer(), ciphertext.toDirectBuffer(), ad.toDirectBuffer(),
        nonce.toDirectBuffer(), key.toDirectBuffer()
      )
    }

    Function("crypto_generichash") { out: Uint8Array, input: Uint8Array, key: Uint8Array ->
      Sodium.generichash(out.toDirectBuffer(), input.toDirectBuffer(), key.toDirectBuffer())
    }
  }
}
