//! Live Activities (docs/adr/0088; README: Live Activities). The relay keeps each host's
//! latest sealed slice per activity token, in memory only, and sends the merged state to
//! the push service: routine updates at most once per interval per token, a new Needs You
//! at once with the alert. Slices are opaque; it reads only `active` and `alert`.
//!
//! This is the state alone. It returns what to do as an `Effect`; the server runs them.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::wire::{Address, Environment, WakeOutcome};

/// How often a routine update may go to one activity.
pub const LIVE_INTERVAL_MS: u64 = 5_000;

/// Hosts one update carries; past it, those with work or Needs You stay.
pub const MAX_LIVE_HOSTS: usize = 6;

/// One device's activity: a token another device's ticket names is another activity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub peer: Address,
    pub environment: Environment,
    pub token: String,
}

#[derive(Debug)]
pub struct LivePut {
    pub host: Address,
    pub peer: Address,
    pub token: String,
    pub environment: Environment,
    /// None: the host leaves this activity.
    pub slice: Option<String>,
    pub active: bool,
    pub alert: bool,
}

#[derive(Debug)]
struct Slot {
    slice: String,
    active: bool,
}

#[derive(Debug)]
struct Activity {
    /// Tells this activity from a later one under the same key.
    id: u64,
    /// By host address, which is the order an update carries them in.
    slots: BTreeMap<Address, Slot>,
    /// When the last push went, in ms; 0 before any.
    last_sent: u64,
    /// The pending timer's number, if one is pending.
    timer: Option<u64>,
}

/// One merged update for the push service.
#[derive(Debug, PartialEq, Eq)]
pub struct Update {
    pub key: Key,
    pub id: u64,
    /// Unix seconds; ActivityKit drops an update older than the one it shows.
    pub timestamp: u64,
    pub slices: Vec<String>,
    pub alert: bool,
    /// How many hosts hold a slice in the activity, for its wide event.
    pub hosts: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    /// Send it, then report the outcome to `delivered`.
    Send(Update),
    /// Call `fired` with these after `wait_ms`.
    Timer { key: Key, id: u64, timer: u64, wait_ms: u64 },
    /// Call `stayed_gone` with these after `wait_ms`.
    Away { host: Address, timer: u64, wait_ms: u64 },
}

/// The slices one push carries, by host address; past six, those with work or Needs You win.
fn merge(slots: &BTreeMap<Address, Slot>) -> Vec<String> {
    if slots.len() <= MAX_LIVE_HOSTS {
        return slots.values().map(|slot| slot.slice.clone()).collect();
    }

    let working = slots.iter().filter(|(_, slot)| slot.active);
    let resting = slots.iter().filter(|(_, slot)| !slot.active);
    let kept: HashSet<&Address> =
        working.chain(resting).take(MAX_LIVE_HOSTS).map(|(host, _)| host).collect();

    slots
        .iter()
        .filter(|(host, _)| kept.contains(host))
        .map(|(_, slot)| slot.slice.clone())
        .collect()
}

pub struct Activities {
    activities: HashMap<Key, Activity>,
    keys_of: HashMap<Address, HashSet<Key>>,
    /// Hosts whose socket is gone, and the number of the timer that drops their slices.
    away: HashMap<Address, u64>,
    limits: LiveLimits,
    next: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct LiveLimits {
    /// Activities held at once, across hosts; a new one past it is ignored.
    pub max_activities: usize,
    /// Activities one host may hold slices in.
    pub max_per_host: usize,
    pub interval_ms: u64,
    /// How long a host's socket may be gone before its slices leave.
    pub host_gone_ms: u64,
}

impl Activities {
    pub fn new(limits: LiveLimits) -> Self {
        Self {
            activities: HashMap::new(),
            keys_of: HashMap::new(),
            away: HashMap::new(),
            limits,
            next: 0,
        }
    }

    pub fn size(&self) -> usize {
        self.activities.len()
    }

    fn number(&mut self) -> u64 {
        self.next += 1;

        self.next
    }

    fn held_by(&self, host: &Address) -> usize {
        self.keys_of.get(host).map_or(0, HashSet::len)
    }

    /// Stores a host's slice and sends, or schedules, the merged update.
    pub fn put(&mut self, put: LivePut, now_ms: u64) -> Option<Effect> {
        let key = Key { peer: put.peer, environment: put.environment, token: put.token };
        let Some(slice) = put.slice else { return self.leave(put.host, &key, now_ms) };

        if !self.admits(put.host, &key) {
            return None;
        }

        let id = self.number();

        let activity = self.activities.entry(key.clone()).or_insert_with(|| Activity {
            id,
            slots: BTreeMap::new(),
            last_sent: 0,
            timer: None,
        });

        activity.slots.insert(put.host, Slot { slice, active: put.active });
        self.keys_of.entry(put.host).or_default().insert(key.clone());

        if put.alert { self.send(&key, true, now_ms) } else { self.schedule(&key, now_ms) }
    }

    /// Whether `host` may hold a slice in the activity at `key`, new or not.
    fn admits(&self, host: Address, key: &Key) -> bool {
        let room = self.held_by(&host) < self.limits.max_per_host;

        match self.activities.get(key) {
            Some(activity) => room || activity.slots.contains_key(&host),
            None => room && self.activities.len() < self.limits.max_activities,
        }
    }

    /// Drops `host`'s slices in activities of devices it no longer lists.
    pub fn unlisted(&mut self, host: Address, listed: &[Address], now_ms: u64) -> Vec<Effect> {
        self.held(host)
            .iter()
            .filter(|key| !listed.contains(&key.peer))
            .filter_map(|key| self.leave(host, key, now_ms))
            .collect()
    }

    fn held(&self, host: Address) -> Vec<Key> {
        self.keys_of.get(&host).into_iter().flatten().cloned().collect()
    }

    /// `host`'s socket is gone: its slices leave after the grace unless it comes back.
    pub fn host_gone(&mut self, host: Address) -> Option<Effect> {
        if self.away.contains_key(&host) || !self.keys_of.contains_key(&host) {
            return None;
        }

        let timer = self.number();
        self.away.insert(host, timer);

        Some(Effect::Away { host, timer, wait_ms: self.limits.host_gone_ms })
    }

    /// `host` is connected again: its slices stay.
    pub fn host_back(&mut self, host: Address) {
        self.away.remove(&host);
    }

    /// The grace ran out: drops the host's slices, unless it came back in the meantime.
    pub fn stayed_gone(&mut self, host: Address, timer: u64, now_ms: u64) -> Vec<Effect> {
        if self.away.get(&host) != Some(&timer) {
            return Vec::new();
        }

        self.away.remove(&host);

        self.held(host).iter().filter_map(|key| self.leave(host, key, now_ms)).collect()
    }

    fn leave(&mut self, host: Address, key: &Key, now_ms: u64) -> Option<Effect> {
        let activity = self.activities.get_mut(key)?;
        activity.slots.remove(&host)?;
        let emptied = activity.slots.is_empty();
        self.forget(host, key);

        if emptied {
            self.activities.remove(key);

            return None;
        }

        self.schedule(key, now_ms)
    }

    fn forget(&mut self, host: Address, key: &Key) {
        let Some(keys) = self.keys_of.get_mut(&host) else { return };

        if keys.remove(key) && keys.is_empty() {
            self.keys_of.remove(&host);
        }
    }

    /// Sends now when the interval has passed, or sets the one timer that will.
    fn schedule(&mut self, key: &Key, now_ms: u64) -> Option<Effect> {
        let timer = self.number();
        let activity = self.activities.get_mut(key)?;

        if activity.timer.is_some() {
            return None;
        }

        let due = activity.last_sent + self.limits.interval_ms;

        if due <= now_ms {
            return self.send(key, false, now_ms);
        }

        activity.timer = Some(timer);

        Some(Effect::Timer { key: key.clone(), id: activity.id, timer, wait_ms: due - now_ms })
    }

    fn send(&mut self, key: &Key, alert: bool, now_ms: u64) -> Option<Effect> {
        let activity = self.activities.get_mut(key)?;
        activity.timer = None;
        activity.last_sent = now_ms;

        Some(Effect::Send(Update {
            key: key.clone(),
            id: activity.id,
            timestamp: now_ms / 1000,
            slices: merge(&activity.slots),
            alert,
            hosts: activity.slots.len(),
        }))
    }

    /// A timer went off: sends the update unless the timer was cancelled or the activity ended.
    pub fn fired(&mut self, key: &Key, id: u64, timer: u64, now_ms: u64) -> Option<Effect> {
        let activity = self.activities.get(key)?;

        if activity.id != id || activity.timer != Some(timer) {
            return None;
        }

        self.send(key, false, now_ms)
    }

    /// A push came back. When APNs no longer knows the token the activity ends, and the
    /// hosts in it, those that joined meanwhile too, are returned to be told.
    pub fn delivered(&mut self, key: &Key, id: u64, outcome: WakeOutcome) -> Option<Vec<Address>> {
        if outcome != WakeOutcome::Unregistered || self.activities.get(key)?.id != id {
            return None;
        }

        let activity = self.activities.remove(key)?;
        let hosts: Vec<Address> = activity.slots.into_keys().collect();

        for host in &hosts {
            self.forget(*host, key);
        }

        Some(hosts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "b2b2";
    const INTERVAL: u64 = 60;

    fn address(n: u8) -> Address {
        Address::parse(format!("{n:02}{}", "A".repeat(20)).as_bytes()).unwrap()
    }

    fn device() -> Address {
        address(99)
    }

    fn put(host: u8, slice: &str) -> LivePut {
        LivePut {
            host: address(host),
            peer: device(),
            token: TOKEN.to_owned(),
            environment: Environment::Sandbox,
            slice: Some(slice.to_owned()),
            active: false,
            alert: false,
        }
    }

    const GRACE: u64 = 40;

    fn limits(max_activities: usize, max_per_host: usize) -> LiveLimits {
        LiveLimits { max_activities, max_per_host, interval_ms: INTERVAL, host_gone_ms: GRACE }
    }

    fn activities(max_per_host: usize) -> Activities {
        Activities::new(limits(10, max_per_host))
    }

    fn away(effect: Option<Effect>) -> (Address, u64) {
        match effect {
            Some(Effect::Away { host, timer, wait_ms: GRACE }) => (host, timer),
            other => panic!("expected the grace timer, got {other:?}"),
        }
    }

    fn sent(effect: Option<Effect>) -> Update {
        match effect {
            Some(Effect::Send(update)) => update,
            other => panic!("expected a send, got {other:?}"),
        }
    }

    fn timer(effect: Option<Effect>) -> (Key, u64, u64, u64) {
        match effect {
            Some(Effect::Timer { key, id, timer, wait_ms }) => (key, id, timer, wait_ms),
            other => panic!("expected a timer, got {other:?}"),
        }
    }

    #[test]
    fn slices_go_by_host_address_and_past_six_the_hosts_with_work_stay() {
        let mut live = activities(4);
        let mut last = None;

        for n in [7, 3, 5] {
            last = live.put(LivePut { alert: true, ..put(n, &format!("s{n}")) }, 1_000);
        }

        assert_eq!(sent(last.take()).slices, ["s3", "s5", "s7"]);

        for n in [1, 6, 2, 4] {
            last =
                live.put(LivePut { alert: true, active: n > 3, ..put(n, &format!("s{n}")) }, 1_000);
        }

        // Seven hosts: 4 and 6 have work; 7, 5 and 3 were stored without, so 7 is the one left out.
        let update = sent(last);
        assert_eq!(update.slices, ["s1", "s2", "s3", "s4", "s5", "s6"]);
        assert_eq!((update.hosts, update.timestamp), (7, 1));
    }

    #[test]
    fn the_first_slice_goes_at_once_and_later_ones_in_the_interval_go_together() {
        let mut live = activities(4);

        assert_eq!(sent(live.put(put(1, "a1"), 1_000)).slices, ["a1"]);
        let (key, id, number, wait) = timer(live.put(put(2, "b1"), 1_010));
        assert_eq!(wait, INTERVAL - 10);
        // One timer is enough: a later slice inside the interval rides on it.
        assert_eq!(live.put(put(1, "a2"), 1_020), None);

        let update = sent(live.fired(&key, id, number, 1_060));
        assert_eq!((update.slices, update.alert), (vec!["a2".to_owned(), "b1".to_owned()], false));
        assert_eq!(live.fired(&key, id, number, 1_061), None);
    }

    #[test]
    fn a_needs_you_goes_at_once_with_the_alert_and_cancels_the_pending_timer() {
        let mut live = activities(4);
        sent(live.put(put(1, "a1"), 1_000));
        let (key, id, number, _) = timer(live.put(put(1, "a2"), 1_010));

        let update = sent(live.put(LivePut { alert: true, active: true, ..put(2, "b1") }, 1_020));
        assert_eq!((update.slices, update.alert), (vec!["a2".to_owned(), "b1".to_owned()], true));
        assert_eq!(live.fired(&key, id, number, 1_060), None);
    }

    #[test]
    fn a_host_that_stops_listing_the_device_leaves_and_the_update_goes_without_it() {
        let mut live = activities(4);
        sent(live.put(put(1, "a1"), 1_000));
        timer(live.put(put(2, "b1"), 1_001));

        // The timer for the routine update is already pending, so leaving adds no effect.
        assert_eq!(live.unlisted(address(1), &[], 1_002), []);
        assert_eq!(live.unlisted(address(2), &[device()], 1_003), []);
        let left = live.put(LivePut { slice: None, ..put(2, "") }, 1_100);

        assert_eq!((left, live.size()), (None, 0));
    }

    #[test]
    fn leaving_an_activity_others_stay_in_sends_what_is_left() {
        let mut live = activities(4);
        sent(live.put(put(1, "a1"), 1_000));
        sent(live.put(LivePut { alert: true, ..put(2, "b1") }, 1_001));

        let effects = live.unlisted(address(1), &[], 2_000);

        assert_eq!(effects.len(), 1);
        assert_eq!(sent(effects.into_iter().next()).slices, ["b1"]);
    }

    #[test]
    fn a_host_whose_socket_stays_gone_leaves_and_one_that_comes_back_keeps_its_slice() {
        let mut live = activities(4);
        sent(live.put(put(1, "a1"), 1_000));
        sent(live.put(LivePut { alert: true, ..put(2, "b1") }, 1_001));

        let (first, first_timer) = away(live.host_gone(address(1)));
        let (second, second_timer) = away(live.host_gone(address(2)));
        // Gone twice is one grace, and a host with no slices needs none.
        assert_eq!((live.host_gone(address(1)), live.host_gone(address(3))), (None, None));
        live.host_back(address(2));

        let effects = live.stayed_gone(first, first_timer, 2_000);
        assert_eq!(sent(effects.into_iter().next()).slices, ["b1"]);
        assert_eq!(live.stayed_gone(second, second_timer, 2_000), []);

        // Gone again after coming back: the earlier grace's timer no longer counts.
        let (_, third_timer) = away(live.host_gone(address(2)));
        assert_eq!((live.stayed_gone(second, second_timer, 2_001), live.size()), (vec![], 1));
        assert_eq!((live.stayed_gone(second, third_timer, 2_002), live.size()), (vec![], 0));
    }

    #[test]
    fn an_unregistered_token_ends_the_activity_and_names_every_host_in_it() {
        let mut live = activities(4);
        let first = sent(live.put(put(1, "a1"), 1_000));
        sent(live.put(LivePut { alert: true, ..put(2, "b1") }, 1_001));

        assert_eq!(live.delivered(&first.key, first.id, WakeOutcome::Sent), None);
        let gone = live.delivered(&first.key, first.id, WakeOutcome::Unregistered);

        assert_eq!((gone, live.size()), (Some(vec![address(1), address(2)]), 0));
        // The same token registered again is a new activity; the old push's reply can't end it.
        let again = sent(live.put(put(1, "a3"), 9_000));
        assert_eq!(live.delivered(&first.key, first.id, WakeOutcome::Unregistered), None);
        assert_eq!((again.slices, live.size()), (vec!["a3".to_owned()], 1));
    }

    #[test]
    fn another_device_s_ticket_for_the_same_token_is_another_activity() {
        let mut live = activities(4);
        let other = address(98);
        assert_eq!(sent(live.put(put(1, "mine"), 1_000)).slices, ["mine"]);

        let theirs = live.put(LivePut { peer: other, alert: true, ..put(2, "theirs") }, 1_001);
        assert_eq!(sent(theirs).slices, ["theirs"]);
        // Host 1 holds no slice in the other device's activity, so its leave there is nothing.
        assert_eq!(live.put(LivePut { peer: other, slice: None, ..put(1, "") }, 1_002), None);
        assert_eq!(live.size(), 2);
    }

    #[test]
    fn a_host_holds_slices_in_at_most_its_share_and_the_relay_in_at_most_its_cap() {
        let mut live = Activities::new(limits(2, 1));
        sent(live.put(put(1, "a1"), 1_000));

        assert_eq!(live.put(LivePut { token: "c3c3".to_owned(), ..put(1, "x1") }, 1_001), None);
        // Its own activity still takes its updates.
        timer(live.put(put(1, "a2"), 1_002));
        sent(live.put(LivePut { token: "c3c3".to_owned(), ..put(2, "y1") }, 1_003));
        assert_eq!(live.put(LivePut { token: "d4d4".to_owned(), ..put(3, "z1") }, 1_004), None);
        assert_eq!(live.size(), 2);
    }
}
