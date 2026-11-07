//! Local images use the same native grants as notes, without exposing a broad
//! asset protocol or accepting arbitrary filesystem paths from document HTML.
use crate::{
    documents::{DocumentId, Documents},
    note_links::resolve_scoped_file,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{fs::File, io::Read};
use tauri::Manager;

const LIMIT: u64 = 8 * 1024 * 1024;
#[derive(Debug, Serialize)]
pub struct Image {
    mime: &'static str,
    data: String,
}

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn load(
    documents: &Documents,
    document: Option<DocumentId>,
    reference: &str,
) -> Result<Image, String> {
    let path = resolve_scoped_file(
        documents,
        document,
        reference,
        false,
        &["png", "jpg", "jpeg", "gif", "webp"],
    )?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Choose a regular image file.".into());
    }
    if metadata.len() > LIMIT {
        return Err("Images must be at most 8 MiB.".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("Images must be at most 8 MiB.".into());
    }
    let mime = mime(&bytes).ok_or("This file is not a supported PNG, JPEG, GIF or WebP image.")?;
    Ok(Image {
        mime,
        data: STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub async fn load_note_image(
    app: tauri::AppHandle,
    document: Option<DocumentId>,
    reference: String,
) -> Result<Image, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load(&app.state::<Documents>(), document, &reference)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Root;
    use std::fs;

    #[test]
    fn images_are_scoped_and_loaded_as_exact_bytes_with_size_and_format_checks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        fs::create_dir(&root).unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(&root).unwrap()));
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        fs::write(root.join("picture.png"), bytes).unwrap();
        let image = load(&documents, None, "picture.png").unwrap();
        assert_eq!(image.mime, "image/png");
        assert_eq!(STANDARD.decode(image.data).unwrap(), bytes);
        fs::write(dir.path().join("outside.png"), bytes).unwrap();
        assert!(load(&documents, None, "../outside.png").is_err());
        documents.granter()(&dir.path().join("outside.png"));
        assert!(
            load(&documents, None, "../outside.png").is_ok(),
            "an explicit native file grant remains usable through a relative alias"
        );
        fs::write(root.join("wrong.png"), "private text").unwrap();
        assert!(load(&documents, None, "wrong.png").is_err());
        fs::write(root.join("diagram.svg"), "<svg></svg>").unwrap();
        assert!(load(&documents, None, "diagram.svg").is_err());
        File::create(root.join("large.png"))
            .unwrap()
            .set_len(LIMIT + 1)
            .unwrap();
        assert!(
            load(&documents, None, "large.png")
                .unwrap_err()
                .contains("8 MiB")
        );
        assert!(load(&documents, None, "https://example.com/picture.png").is_err());
        #[cfg(unix)]
        {
            fs::write(dir.path().join("private.png"), bytes).unwrap();
            std::os::unix::fs::symlink(dir.path().join("private.png"), root.join("escape.png"))
                .unwrap();
            assert!(load(&documents, None, "escape.png").is_err());
        }
    }

    #[test]
    fn saved_notes_resolve_their_own_relative_images() {
        let dir = tempfile::tempdir().unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(dir.path()).unwrap()));
        let mut loaded = Vec::new();
        for folder in ["one", "two"] {
            let path = dir.path().join(folder);
            fs::create_dir(&path).unwrap();
            fs::write(path.join("note.md"), "![Picture](picture.png)").unwrap();
            let bytes = [b"\x89PNG\r\n\x1a\n".as_slice(), folder.as_bytes()].concat();
            fs::write(path.join("picture.png"), &bytes).unwrap();
            let id = documents
                .restore_recovery(Some((path.join("note.md"), None)), "", false)
                .unwrap()
                .0;
            let image = load(&documents, Some(id), "picture.png").unwrap();
            assert_eq!(STANDARD.decode(&image.data).unwrap(), bytes);
            loaded.push(image.data);
        }
        assert_ne!(loaded[0], loaded[1]);
    }

    #[test]
    fn supported_signatures_are_distinct_and_fake_images_are_refused() {
        for (bytes, expected) in [
            (&b"\xff\xd8\xffdata"[..], "image/jpeg"),
            (&b"GIF89adata"[..], "image/gif"),
            (&b"RIFF1234WEBPdata"[..], "image/webp"),
        ] {
            assert_eq!(mime(bytes), Some(expected));
        }
        assert_eq!(mime(b"<svg onload='alert(1)'>"), None);
        assert_eq!(mime(b"RIFF1234WAVE"), None);
    }
}
