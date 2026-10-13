//! Password protection (AES-256) and removing a known password.

use std::collections::BTreeMap;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Document, EncryptionState, EncryptionVersion, Permissions};

use crate::Res;
use crate::ops::{finish, load};

pub fn protect(bytes: &[u8], user_password: &str, owner_password: &str, allow_print: bool, allow_copy: bool) -> Res<Vec<u8>> {
    if user_password.is_empty() {
        return Err("INVALID: choose a password".into());
    }
    let mut doc = load(bytes)?;
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| e.to_string())?;
    let owner = if owner_password.is_empty() {
        let mut r = [0u8; 16];
        getrandom::fill(&mut r).map_err(|e| e.to_string())?;
        r.iter().map(|b| format!("{b:02x}")).collect::<String>()
    } else {
        owner_password.to_string()
    };
    let mut permissions = Permissions::COPYABLE_FOR_ACCESSIBILITY;
    if allow_print {
        permissions |= Permissions::PRINTABLE | Permissions::PRINTABLE_IN_HIGH_QUALITY;
    }
    if allow_copy {
        permissions |= Permissions::COPYABLE;
    }
    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner,
        user_password,
        permissions,
    };
    let state = EncryptionState::try_from(version).map_err(|e| e.to_string())?;
    // Encrypt after pruning so the saved objects are the encrypted ones.
    doc.prune_objects();
    doc.renumber_objects();
    doc.encrypt(&state).map_err(|e| e.to_string())?;
    // Apple's PDFKit refuses AES-256 filters that omit the key length.
    if let Ok(id) = doc.trailer.get(b"Encrypt").and_then(lopdf::Object::as_reference)
        && let Ok(enc) = doc.get_dictionary_mut(id)
        && let Ok(lopdf::Object::Dictionary(cf)) = enc.get_mut(b"CF")
        && let Ok(lopdf::Object::Dictionary(std)) = cf.get_mut(b"StdCF")
    {
        std.set("Length", 32);
        std.set("AuthEvent", "DocOpen");
    }
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn unlock(bytes: &[u8], password: &str) -> Res<Vec<u8>> {
    if let Ok(doc) = load(bytes) {
        // Opens without a password: only owner restrictions, which are dropped on save.
        return finish(doc, false);
    }
    let mut doc = Document::load_mem_with_options(bytes, lopdf::LoadOptions::with_password(password)).map_err(|e| {
        let m = e.to_string().to_lowercase();
        if m.contains("password") || m.contains("decrypt") || m.contains("authent") {
            "PASSWORD: that password is not right".to_string()
        } else {
            format!("INVALID: could not read this PDF ({e})")
        }
    })?;
    if doc.is_encrypted() {
        doc.decrypt(password).map_err(|_| "PASSWORD: that password is not right".to_string())?;
    }
    doc.trailer.remove(b"Encrypt");
    finish(doc, false)
}
