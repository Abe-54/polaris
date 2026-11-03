#include <jni.h>
#include <limits.h>
#include <stdio.h>
#include <sodium.h>

#define METHOD(name) Java_dev_lux_polaris_sodium_Sodium_##name

typedef struct {
    unsigned char *data;
    size_t size;
} Buffer;

static void fail(JNIEnv *env, const char *message)
{
    jclass exception = (*env)->FindClass(env, "dev/lux/polaris/sodium/SodiumException");
    if (exception != NULL) {
        (*env)->ThrowNew(env, exception, message);
        (*env)->DeleteLocalRef(env, exception);
    }
}

static int buffer(JNIEnv *env, jobject value, Buffer *out)
{
    static unsigned char empty;
    jlong capacity = value == NULL ? -1 : (*env)->GetDirectBufferCapacity(env, value);
    if (capacity < 0 || capacity > INT_MAX) {
        fail(env, "expected a direct byte buffer");
        return 0;
    }
    out->size = (size_t) capacity;
    out->data = (*env)->GetDirectBufferAddress(env, value);
    if (out->size == 0) {
        out->data = &empty;
    } else if (out->data == NULL) {
        fail(env, "expected a direct byte buffer");
        return 0;
    }
    return 1;
}

static int expect(JNIEnv *env, Buffer value, size_t size, const char *name)
{
    if (value.size != size) {
        char message[128];
        snprintf(message, sizeof message, "%s must be %zu bytes, not %zu", name, size, value.size);
        fail(env, message);
        return 0;
    }
    return 1;
}

static int succeed(JNIEnv *env, int status, const char *message)
{
    if (status != 0) {
        fail(env, message);
        return 0;
    }
    return 1;
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved)
{
    return sodium_init() < 0 ? JNI_ERR : JNI_VERSION_1_6;
}

JNIEXPORT void JNICALL METHOD(randombytesBuf)(JNIEnv *env, jclass cls, jobject value)
{
    Buffer out;
    if (buffer(env, value, &out)) {
        randombytes_buf(out.data, out.size);
    }
}

JNIEXPORT void JNICALL METHOD(hashSha256)(JNIEnv *env, jclass cls, jobject o, jobject i)
{
    Buffer out, input;
    if (!buffer(env, o, &out) || !buffer(env, i, &input) ||
        !expect(env, out, crypto_hash_sha256_BYTES, "out")) return;
    succeed(env, crypto_hash_sha256(out.data, input.data, input.size), "sha256 failed");
}

JNIEXPORT void JNICALL METHOD(signKeypair)(JNIEnv *env, jclass cls, jobject p, jobject s)
{
    Buffer pk, sk;
    if (!buffer(env, p, &pk) || !buffer(env, s, &sk) ||
        !expect(env, pk, crypto_sign_PUBLICKEYBYTES, "publicKey") ||
        !expect(env, sk, crypto_sign_SECRETKEYBYTES, "secretKey")) return;
    succeed(env, crypto_sign_keypair(pk.data, sk.data), "sign keypair failed");
}

JNIEXPORT void JNICALL METHOD(signSeedKeypair)(JNIEnv *env, jclass cls, jobject p, jobject s, jobject seed_value)
{
    Buffer pk, sk, seed;
    if (!buffer(env, p, &pk) || !buffer(env, s, &sk) || !buffer(env, seed_value, &seed) ||
        !expect(env, pk, crypto_sign_PUBLICKEYBYTES, "publicKey") ||
        !expect(env, sk, crypto_sign_SECRETKEYBYTES, "secretKey") ||
        !expect(env, seed, crypto_sign_SEEDBYTES, "seed")) return;
    succeed(env, crypto_sign_seed_keypair(pk.data, sk.data, seed.data), "seed keypair failed");
}

JNIEXPORT void JNICALL METHOD(signDetached)(JNIEnv *env, jclass cls, jobject sig, jobject m, jobject s)
{
    Buffer signature, message, sk;
    if (!buffer(env, sig, &signature) || !buffer(env, m, &message) || !buffer(env, s, &sk) ||
        !expect(env, signature, crypto_sign_BYTES, "signature") ||
        !expect(env, sk, crypto_sign_SECRETKEYBYTES, "secretKey")) return;
    succeed(env, crypto_sign_detached(signature.data, NULL, message.data, message.size, sk.data), "sign failed");
}

JNIEXPORT void JNICALL METHOD(kxKeypair)(JNIEnv *env, jclass cls, jobject p, jobject s)
{
    Buffer pk, sk;
    if (!buffer(env, p, &pk) || !buffer(env, s, &sk) ||
        !expect(env, pk, crypto_kx_PUBLICKEYBYTES, "publicKey") ||
        !expect(env, sk, crypto_kx_SECRETKEYBYTES, "secretKey")) return;
    succeed(env, crypto_kx_keypair(pk.data, sk.data), "kx keypair failed");
}

JNIEXPORT void JNICALL METHOD(kxSeedKeypair)(JNIEnv *env, jclass cls, jobject p, jobject s, jobject seed_value)
{
    Buffer pk, sk, seed;
    if (!buffer(env, p, &pk) || !buffer(env, s, &sk) || !buffer(env, seed_value, &seed) ||
        !expect(env, pk, crypto_kx_PUBLICKEYBYTES, "publicKey") ||
        !expect(env, sk, crypto_kx_SECRETKEYBYTES, "secretKey") ||
        !expect(env, seed, crypto_kx_SEEDBYTES, "seed")) return;
    succeed(env, crypto_kx_seed_keypair(pk.data, sk.data, seed.data), "kx seed keypair failed");
}

JNIEXPORT void JNICALL METHOD(scalarmult)(JNIEnv *env, jclass cls, jobject o, jobject s, jobject p)
{
    Buffer out, sk, pk;
    if (!buffer(env, o, &out) || !buffer(env, s, &sk) || !buffer(env, p, &pk) ||
        !expect(env, out, crypto_scalarmult_BYTES, "output") ||
        !expect(env, sk, crypto_scalarmult_SCALARBYTES, "secretKey") ||
        !expect(env, pk, crypto_scalarmult_BYTES, "publicKey")) return;
    succeed(env, crypto_scalarmult(out.data, sk.data, pk.data), "scalarmult failed");
}

JNIEXPORT void JNICALL METHOD(scalarmultBase)(JNIEnv *env, jclass cls, jobject o, jobject s)
{
    Buffer out, sk;
    if (!buffer(env, o, &out) || !buffer(env, s, &sk) ||
        !expect(env, out, crypto_scalarmult_BYTES, "output") ||
        !expect(env, sk, crypto_scalarmult_SCALARBYTES, "secretKey")) return;
    succeed(env, crypto_scalarmult_base(out.data, sk.data), "scalarmult base failed");
}

static int aead_buffers(JNIEnv *env, jobject o, jobject i, jobject a, jobject n, jobject k,
                        Buffer *out, Buffer *input, Buffer *ad, Buffer *nonce, Buffer *key)
{
    return buffer(env, o, out) && buffer(env, i, input) && buffer(env, a, ad) &&
           buffer(env, n, nonce) && buffer(env, k, key);
}

static int aead_key(JNIEnv *env, Buffer nonce, Buffer key)
{
    return expect(env, nonce, crypto_aead_chacha20poly1305_ietf_NPUBBYTES, "nonce") &&
           expect(env, key, crypto_aead_chacha20poly1305_ietf_KEYBYTES, "key");
}

JNIEXPORT jint JNICALL METHOD(encrypt)(JNIEnv *env, jclass cls, jobject o, jobject i, jobject a, jobject n, jobject k)
{
    Buffer out, message, ad, nonce, key;
    if (!aead_buffers(env, o, i, a, n, k, &out, &message, &ad, &nonce, &key) ||
        !expect(env, out, message.size + crypto_aead_chacha20poly1305_ietf_ABYTES, "ciphertext") ||
        !aead_key(env, nonce, key)) return 0;
    unsigned long long written = 0;
    if (!succeed(env, crypto_aead_chacha20poly1305_ietf_encrypt(out.data, &written,
        message.data, message.size, ad.data, ad.size, NULL, nonce.data, key.data), "encrypt failed")) return 0;
    return (jint) written;
}

JNIEXPORT jint JNICALL METHOD(decrypt)(JNIEnv *env, jclass cls, jobject o, jobject i, jobject a, jobject n, jobject k)
{
    Buffer out, ciphertext, ad, nonce, key;
    if (!aead_buffers(env, o, i, a, n, k, &out, &ciphertext, &ad, &nonce, &key)) return 0;
    if (ciphertext.size < crypto_aead_chacha20poly1305_ietf_ABYTES) {
        fail(env, "ciphertext is too short");
        return 0;
    }
    if (!expect(env, out, ciphertext.size - crypto_aead_chacha20poly1305_ietf_ABYTES, "message") ||
        !aead_key(env, nonce, key)) return 0;
    unsigned long long written = 0;
    if (!succeed(env, crypto_aead_chacha20poly1305_ietf_decrypt(out.data, &written, NULL,
        ciphertext.data, ciphertext.size, ad.data, ad.size, nonce.data, key.data), "could not verify data")) return 0;
    return (jint) written;
}

JNIEXPORT void JNICALL METHOD(generichash)(JNIEnv *env, jclass cls, jobject o, jobject i, jobject k)
{
    Buffer out, input, key;
    if (!buffer(env, o, &out) || !buffer(env, i, &input) || !buffer(env, k, &key)) return;
    if (out.size < crypto_generichash_BYTES_MIN || out.size > crypto_generichash_BYTES_MAX) {
        fail(env, "hash output must be 16 to 64 bytes");
        return;
    }
    if (key.size != 0 && (key.size < crypto_generichash_KEYBYTES_MIN || key.size > crypto_generichash_KEYBYTES_MAX)) {
        fail(env, "hash key must be 16 to 64 bytes");
        return;
    }
    succeed(env, crypto_generichash(out.data, out.size, input.data, input.size,
        key.size == 0 ? NULL : key.data, key.size), "generichash failed");
}
