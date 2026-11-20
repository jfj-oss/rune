//! Typing in the queue filters it: every word typed must appear in the title, an artist or the album (any case).
use crate::model::QueueItem;

/// Indices into `queue` of the items that match `query`, in queue order. An empty query matches everything.
pub fn matches(queue: &[QueueItem], query: &str) -> Vec<usize> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    queue
        .iter()
        .enumerate()
        .filter(|(_, q)| {
            if words.is_empty() {
                return true;
            }
            let hay = format!("{} {} {}", q.track.title, q.artist_line(), q.album.title).to_lowercase();
            words.iter().all(|w| hay.contains(w))
        })
        .map(|(i, _)| i)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AlbumRef, ArtistRef, Track};
    fn item(id: &str, title: &str, artist: &str, album: &str) -> QueueItem {
        QueueItem {
            queue_id: id.into(),
            track: Track { title: title.into(), artists: vec![ArtistRef { id: "a".into(), name: artist.into() }], ..Default::default() },
            album: AlbumRef { title: album.into(), ..Default::default() },
        }
    }
    #[test]
    fn words_and_case() {
        let q = vec![item("1", "Blue Monday", "New Order", "Power"), item("2", "Bizarre Love", "New Order", "Brotherhood"), item("3", "Blue", "Joni", "Blue")];
        assert_eq!(matches(&q, ""), vec![0, 1, 2]);
        assert_eq!(matches(&q, "BLUE"), vec![0, 2]);
        assert_eq!(matches(&q, "new order bro"), vec![1]);
        assert_eq!(matches(&q, "zzz"), Vec::<usize>::new());
    }
}
