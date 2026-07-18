use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SanctionedEntity {
    pub name: String,
    pub bvn: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SanctionsList {
    entities: Vec<SanctionedEntity>,
}

fn normalize(name: &str) -> String {
    name.trim().to_lowercase()
}

impl SanctionsList {
    pub fn from_entities(entities: Vec<SanctionedEntity>) -> Self {
        Self { entities }
    }

    pub fn len(&self) -> usize {
        self.entities.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entities.is_empty()
    }

    pub fn match_entity(&self, name: &str, bvn: Option<&str>) -> Option<&SanctionedEntity> {
        self.entities.iter().find(|e| {
            (bvn.is_some() && e.bvn.as_deref() == bvn) || normalize(&e.name) == normalize(name)
        })
    }
}

#[derive(Debug)]
pub enum SanctionsLoadError {
    Io(String),
    Parse(String),
}

impl fmt::Display for SanctionsLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SanctionsLoadError::Io(msg) => write!(f, "failed to load sanctions list: {msg}"),
            SanctionsLoadError::Parse(msg) => write!(f, "failed to parse sanctions list: {msg}"),
        }
    }
}

impl std::error::Error for SanctionsLoadError {}

pub trait SanctionsListSource: Send + Sync {
    fn load(&self) -> Result<SanctionsList, SanctionsLoadError>;
}

/// Loads a JSON array of `SanctionedEntity` from a local file path.
pub struct FileSanctionsListSource {
    pub path: PathBuf,
}

impl SanctionsListSource for FileSanctionsListSource {
    fn load(&self) -> Result<SanctionsList, SanctionsLoadError> {
        let data = std::fs::read_to_string(&self.path)
            .map_err(|e| SanctionsLoadError::Io(e.to_string()))?;
        let entities: Vec<SanctionedEntity> =
            serde_json::from_str(&data).map_err(|e| SanctionsLoadError::Parse(e.to_string()))?;
        Ok(SanctionsList::from_entities(entities))
    }
}

type S3Fetcher = Box<dyn Fn(&str) -> Result<String, SanctionsLoadError> + Send + Sync>;

/// Loads a JSON array of `SanctionedEntity` from an S3 path (`s3://bucket/key`) via a
/// caller-supplied fetcher, keeping this crate free of an AWS SDK dependency while still
/// satisfying "configurable S3 path" sourcing.
pub struct S3SanctionsListSource {
    pub s3_path: String,
    fetcher: S3Fetcher,
}

impl S3SanctionsListSource {
    pub fn new(
        s3_path: impl Into<String>,
        fetcher: impl Fn(&str) -> Result<String, SanctionsLoadError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            s3_path: s3_path.into(),
            fetcher: Box::new(fetcher),
        }
    }
}

impl SanctionsListSource for S3SanctionsListSource {
    fn load(&self) -> Result<SanctionsList, SanctionsLoadError> {
        let data = (self.fetcher)(&self.s3_path)?;
        let entities: Vec<SanctionedEntity> =
            serde_json::from_str(&data).map_err(|e| SanctionsLoadError::Parse(e.to_string()))?;
        Ok(SanctionsList::from_entities(entities))
    }
}

/// Wraps a `SanctionsListSource` with an in-memory cache that refreshes after `ttl` elapses,
/// per the requirement that the sanctions list be cached with a 1h refresh TTL.
pub struct CachedSanctionsList {
    source: Box<dyn SanctionsListSource>,
    ttl: Duration,
    cached: Mutex<Option<(Instant, SanctionsList)>>,
}

impl CachedSanctionsList {
    pub fn new(source: Box<dyn SanctionsListSource>, ttl: Duration) -> Self {
        Self {
            source,
            ttl,
            cached: Mutex::new(None),
        }
    }

    pub fn with_default_ttl(source: Box<dyn SanctionsListSource>) -> Self {
        Self::new(source, Duration::from_secs(3600))
    }

    pub fn get(&self) -> Result<SanctionsList, SanctionsLoadError> {
        let mut guard = self.cached.lock().expect("sanctions list cache poisoned");
        if let Some((loaded_at, list)) = guard.as_ref() {
            if loaded_at.elapsed() < self.ttl {
                return Ok(list.clone());
            }
        }
        let fresh = self.source.load()?;
        *guard = Some((Instant::now(), fresh.clone()));
        Ok(fresh)
    }

    pub fn invalidate(&self) {
        *self.cached.lock().expect("sanctions list cache poisoned") = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn matches_by_bvn_regardless_of_name() {
        let list = SanctionsList::from_entities(vec![SanctionedEntity {
            name: "Jane Smith".to_string(),
            bvn: Some("11122233344".to_string()),
            source: "UN".to_string(),
        }]);
        assert!(list.match_entity("Different Name", Some("11122233344")).is_some());
    }

    #[test]
    fn matches_by_normalized_name_when_no_bvn_given() {
        let list = SanctionsList::from_entities(vec![SanctionedEntity {
            name: "Jane Smith".to_string(),
            bvn: None,
            source: "UN".to_string(),
        }]);
        assert!(list.match_entity("  JANE smith  ", None).is_some());
    }

    #[test]
    fn no_match_returns_none() {
        let list = SanctionsList::from_entities(vec![SanctionedEntity {
            name: "Jane Smith".to_string(),
            bvn: None,
            source: "UN".to_string(),
        }]);
        assert!(list.match_entity("Someone Else", Some("00000000000")).is_none());
    }

    #[test]
    fn file_source_loads_entities_from_json() {
        let mut file = tempfile();
        writeln!(
            file.1,
            r#"[{{"name": "Jane Smith", "bvn": null, "source": "OFAC"}}]"#
        )
        .unwrap();
        let source = FileSanctionsListSource { path: file.0.clone() };
        let list = source.load().unwrap();
        assert_eq!(list.len(), 1);
        std::fs::remove_file(&file.0).ok();
    }

    #[test]
    fn cached_list_reuses_result_within_ttl() {
        let call_count = Arc::new(AtomicUsize::new(0));
        let counted = call_count.clone();
        let source = CountingSource { calls: counted };
        let cache = CachedSanctionsList::new(Box::new(source), Duration::from_secs(3600));

        cache.get().unwrap();
        cache.get().unwrap();

        assert_eq!(call_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cached_list_refreshes_after_ttl_elapses() {
        let call_count = Arc::new(AtomicUsize::new(0));
        let counted = call_count.clone();
        let source = CountingSource { calls: counted };
        let cache = CachedSanctionsList::new(Box::new(source), Duration::from_millis(0));

        cache.get().unwrap();
        std::thread::sleep(Duration::from_millis(5));
        cache.get().unwrap();

        assert_eq!(call_count.load(Ordering::SeqCst), 2);
    }

    struct CountingSource {
        calls: Arc<AtomicUsize>,
    }

    impl SanctionsListSource for CountingSource {
        fn load(&self) -> Result<SanctionsList, SanctionsLoadError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(SanctionsList::default())
        }
    }

    fn tempfile() -> (PathBuf, std::fs::File) {
        let path = std::env::temp_dir().join(format!(
            "aml-sanctions-test-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = std::fs::File::create(&path).unwrap();
        (path, file)
    }
}
