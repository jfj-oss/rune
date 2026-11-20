import AppKit
import AVFoundation
import MediaPlayer
import RuneMiniCore

/// Media keys and Control Center. The panel can be hidden (it usually is): the keys still reach rune, because
///  1. MPRemoteCommandCenter has handlers for play, pause, toggle, next, previous and scrubbing, and
///  2. MPNowPlayingInfoCenter carries what plays (title, artist, album, cover, length, elapsed, rate) and a playbackState.
/// macOS gives the keys to the "Now Playing app", which is normally the app that last played audio. rune mini plays none,
/// so while rune is PLAYING it keeps a silent audio stream going (an AVAudioPlayer loop of digital zeros at volume 0,
/// a 1-second buffer in memory) to be the app macOS counts as playing. It is stopped when rune pauses or stops, and the
/// menu item "Claim media keys with silent audio" turns it off. Whether macOS routes the keys without it depends on the
/// macOS version, so it is on by default. See native/mac/README.md ("Media keys").
/// Cost: no timers here; commands and updates arrive only when rune's state changes (elapsed time + rate let the system
/// extrapolate the progress by itself).
final class NowPlaying {
    var onCommand: ((UiCommand) -> Void)?
    var silentClaim: Bool {
        get { UserDefaults.standard.object(forKey: "silentClaim") == nil ? true : UserDefaults.standard.bool(forKey: "silentClaim") }
        set { UserDefaults.standard.set(newValue, forKey: "silentClaim"); if !newValue { stopSilence() } }
    }

    private var armed = false
    private var player: AVAudioPlayer?
    private var lastKey = ""
    private var lastCover: NSImage?

    func arm() {
        guard !armed else { return }
        armed = true
        let cc = MPRemoteCommandCenter.shared()
        func on(_ c: MPRemoteCommand, _ f: @escaping () -> UiCommand) {
            c.isEnabled = true
            c.addTarget { [weak self] _ in
                DispatchQueue.main.async { self?.onCommand?(f()) }
                return .success
            }
        }
        on(cc.playCommand) { .play }
        on(cc.pauseCommand) { .pause }
        on(cc.togglePlayPauseCommand) { .playPause }
        on(cc.nextTrackCommand) { .next }
        on(cc.previousTrackCommand) { .prev }
        cc.changePlaybackPositionCommand.isEnabled = true
        cc.changePlaybackPositionCommand.addTarget { [weak self] ev in
            guard let e = ev as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let ms = e.positionTime * 1000
            DispatchQueue.main.async { self?.onCommand?(.seekTo(ms)) }
            return .success
        }
        cc.changeShuffleModeCommand.isEnabled = true
        cc.changeShuffleModeCommand.addTarget { [weak self] ev in
            if let e = ev as? MPChangeShuffleModeCommandEvent { DispatchQueue.main.async { self?.onCommand?(.setShuffle(e.shuffleType != .off)) } }
            return .success
        }
        cc.changeRepeatModeCommand.isEnabled = true
        cc.changeRepeatModeCommand.addTarget { [weak self] ev in
            if let e = ev as? MPChangeRepeatModeCommandEvent {
                let r: Repeat = e.repeatType == .one ? .one : (e.repeatType == .all ? .all : .off)
                DispatchQueue.main.async { self?.onCommand?(.setRepeat(r)) }
            }
            return .success
        }
    }

    /// Called after every state change. Cheap: it compares what it would publish with what it published.
    func update(model: Model, cover: NSImage?, base: String) {
        arm()
        let center = MPNowPlayingInfoCenter.default()
        guard let p = model.player, let cur = p.current, model.online else {
            if lastKey != "none" {
                lastKey = "none"
                center.nowPlayingInfo = nil
                center.playbackState = .stopped
                stopSilence()
            }
            return
        }
        let playing = p.status == .playing || p.status == .loading
        // the elapsed time is only re-published when something other than the clock changed
        let key = "\(cur.queueId)|\(p.status.rawValue)|\(Int(p.positionMs / 1000))|\(cover != nil)"
        if key == lastKey && cover === lastCover { return }
        lastKey = key
        lastCover = cover
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: cur.track.title,
            MPMediaItemPropertyArtist: cur.artistLine,
            MPMediaItemPropertyAlbumTitle: cur.album.title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: p.position(now: nowMs()) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if cur.track.durationMs > 0 { info[MPMediaItemPropertyPlaybackDuration] = cur.track.durationMs / 1000 }
        if let img = cover {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        }
        center.nowPlayingInfo = info
        center.playbackState = playing ? .playing : (p.status == .paused ? .paused : .stopped)
        if playing && silentClaim { startSilence() } else { stopSilence() }
    }

    // MARK: the silent stream

    private func startSilence() {
        if player?.isPlaying == true { return }
        if player == nil {
            player = try? AVAudioPlayer(data: NowPlaying.silentWav(seconds: 1))
            player?.numberOfLoops = -1
            player?.volume = 0
        }
        player?.play()
    }

    private func stopSilence() {
        player?.stop()
        player = nil
    }

    /// A WAV of digital silence: mono, 8 kHz, 16-bit, in memory.
    static func silentWav(seconds: Int) -> Data {
        let rate = 8000, n = rate * seconds
        var d = Data()
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append(Data("RIFF".utf8)); u32(36 + n * 2); d.append(Data("WAVEfmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(Data("data".utf8)); u32(n * 2); d.append(Data(count: n * 2))
        return d
    }
}
