//! Who is online and who may reach whom. A host names its linked devices; a device and a
//! host reach each other only while the host lists the device. Held in memory for the life
//! of the connections, never persisted.

use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexSet;

use crate::wire::{Address, Role, presence};

/// A party's connection, as the hub sees it.
pub trait Endpoint {
    fn address(&self) -> Address;
    fn role(&self) -> Role;
    /// Queues a control message, after every data frame already forwarded to this socket.
    fn send(&self, message: &str);
    /// Closes the socket because a newer connection proved the same key.
    fn replace(&self);
}

/// Insertion-ordered, as the TypeScript relay's sets are, so announcements go in one order.
type Addresses = IndexSet<Address>;

pub struct Hub<E: Endpoint> {
    online: HashMap<Address, Arc<E>>,
    /// Host → the devices it links.
    devices_of: HashMap<Address, Addresses>,
    /// Device → the online hosts that link it.
    hosts_of: HashMap<Address, Addresses>,
}

impl<E: Endpoint> Default for Hub<E> {
    fn default() -> Self {
        Self { online: HashMap::new(), devices_of: HashMap::new(), hosts_of: HashMap::new() }
    }
}

impl<E: Endpoint> Hub<E> {
    fn is_current(&self, endpoint: &Arc<E>) -> bool {
        self.online.get(&endpoint.address()).is_some_and(|current| Arc::ptr_eq(current, endpoint))
    }

    /// Registers `endpoint`, replacing an older connection of the same key, and announces it.
    pub fn attach(&mut self, endpoint: Arc<E>, peers: &[Address]) {
        let address = endpoint.address();

        if let Some(previous) = self.online.remove(&address) {
            self.unlist(address);
            previous.replace();
        }

        self.online.insert(address, endpoint.clone());

        if endpoint.role() == Role::Host {
            self.set_peers(&endpoint, peers);
        } else {
            self.announce_to_hosts(address, true);
        }
    }

    /// Removes `endpoint` if it is still the current connection for its key.
    pub fn detach(&mut self, endpoint: &Arc<E>) {
        if !self.is_current(endpoint) {
            return;
        }

        let address = endpoint.address();
        self.online.remove(&address);

        if endpoint.role() == Role::Host {
            self.unlist(address);
        } else {
            self.announce_to_hosts(address, false);
        }
    }

    /// Replaces a host's linked devices, announcing each change to whoever is online. A
    /// socket a newer one replaced changes nothing: the list is the newer socket's now.
    pub fn set_peers(&mut self, host: &Arc<E>, peers: &[Address]) {
        if self.is_current(host) {
            self.list(host.address(), peers.iter().copied().collect());
        }
    }

    /// Forgets everything the host at `address`, now offline, listed.
    fn unlist(&mut self, address: Address) {
        self.list(address, Addresses::new());
        self.devices_of.remove(&address);
    }

    fn list(&mut self, address: Address, after: Addresses) {
        let before = self.devices_of.remove(&address).unwrap_or_default();

        for device in before.iter().filter(|device| !after.contains(*device)) {
            self.forget(address, *device);
            self.announce(address, *device, false);
        }

        for device in after.iter().filter(|device| !before.contains(*device)) {
            self.hosts_of.entry(*device).or_default().insert(address);
            self.announce(address, *device, true);
        }

        self.devices_of.insert(address, after);
    }

    /// Drops `host` from `device`'s hosts, and the entry with its last host.
    fn forget(&mut self, host: Address, device: Address) {
        let Some(hosts) = self.hosts_of.get_mut(&device) else { return };

        if hosts.shift_remove(&host) && hosts.is_empty() {
            self.hosts_of.remove(&device);
        }
    }

    /// The endpoint `from` may deliver to at `to`, or none when it is offline or not linked.
    pub fn route(&self, from: Address, role: Role, to: &Address) -> Option<&Arc<E>> {
        let target = self.online.get(to)?;

        if target.role() == role {
            return None;
        }

        let (host, device) = if role == Role::Host { (from, *to) } else { (*to, from) };

        self.devices_of.get(&host)?.contains(&device).then_some(target)
    }

    /// The online host at `address`, if any.
    pub fn host(&self, address: &Address) -> Option<&Arc<E>> {
        self.endpoint(address, Role::Host)
    }

    pub fn size(&self) -> usize {
        self.online.len()
    }

    fn announce_to_hosts(&self, device: Address, online: bool) {
        let Some(hosts) = self.hosts_of.get(&device) else { return };

        for host in hosts {
            self.announce(*host, device, online);
        }
    }

    /// Tells a host and a device that the other came (both online) or went (whichever is
    /// still online).
    fn announce(&self, host: Address, device: Address, online: bool) {
        let host_endpoint = self.endpoint(&host, Role::Host);
        let device_endpoint = self.endpoint(&device, Role::Device);

        if online && (host_endpoint.is_none() || device_endpoint.is_none()) {
            return;
        }

        if let Some(endpoint) = host_endpoint {
            endpoint.send(&presence(&device, online));
        }

        if let Some(endpoint) = device_endpoint {
            endpoint.send(&presence(&host, online));
        }
    }

    fn endpoint(&self, address: &Address, role: Role) -> Option<&Arc<E>> {
        self.online.get(address).filter(|endpoint| endpoint.role() == role)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// An endpoint that records what the hub told it.
    struct Fake {
        address: Address,
        role: Role,
        heard: Mutex<Vec<String>>,
    }

    impl Endpoint for Fake {
        fn address(&self) -> Address {
            self.address
        }

        fn role(&self) -> Role {
            self.role
        }

        fn send(&self, message: &str) {
            self.heard.lock().unwrap().push(message.to_owned());
        }

        fn replace(&self) {
            self.heard.lock().unwrap().push("replaced".to_owned());
        }
    }

    fn address(n: u8) -> Address {
        Address::of_key(&[n; 32])
    }

    fn party(n: u8, role: Role) -> Arc<Fake> {
        Arc::new(Fake { address: address(n), role, heard: Mutex::new(Vec::new()) })
    }

    /// What `party` heard since it was last asked.
    fn heard(party: &Fake) -> Vec<String> {
        std::mem::take(&mut *party.heard.lock().unwrap())
    }

    fn routes(hub: &Hub<Fake>, from: &Fake, to: &Fake) -> bool {
        hub.route(from.address, from.role, &to.address).is_some()
    }

    #[test]
    fn a_host_and_the_device_it_lists_hear_each_other_and_route_both_ways() {
        let mut hub = Hub::default();
        let (host, device) = (party(1, Role::Host), party(2, Role::Device));

        hub.attach(host.clone(), &[device.address]);
        assert_eq!(heard(&host), Vec::<String>::new());
        hub.attach(device.clone(), &[]);

        assert_eq!(heard(&host), [presence(&device.address, true)]);
        assert_eq!(heard(&device), [presence(&host.address, true)]);
        assert!(routes(&hub, &host, &device) && routes(&hub, &device, &host));
    }

    #[test]
    fn nothing_routes_without_the_host_s_listing_or_between_two_of_a_kind() {
        let mut hub = Hub::default();
        let (host, other) = (party(1, Role::Host), party(3, Role::Host));
        let (device, stranger) = (party(2, Role::Device), party(4, Role::Device));

        hub.attach(host.clone(), &[device.address, other.address]);
        hub.attach(other.clone(), &[host.address]);
        hub.attach(device.clone(), &[]);
        hub.attach(stranger.clone(), &[]);

        assert!(!routes(&hub, &stranger, &host) && !routes(&hub, &host, &stranger));
        assert!(!routes(&hub, &host, &other) && !routes(&hub, &other, &host));
        assert!(!routes(&hub, &device, &stranger));
        assert_eq!(heard(&stranger), Vec::<String>::new());
    }

    #[test]
    fn unlinking_announces_both_ways_and_stops_routing() {
        let mut hub = Hub::default();
        let (host, device) = (party(1, Role::Host), party(2, Role::Device));
        hub.attach(host.clone(), &[device.address]);
        hub.attach(device.clone(), &[]);
        heard(&host);
        heard(&device);

        hub.set_peers(&host, &[]);

        assert_eq!(heard(&device), [presence(&host.address, false)]);
        assert_eq!(heard(&host), [presence(&device.address, false)]);
        assert!(!routes(&hub, &device, &host));
    }

    #[test]
    fn a_party_that_leaves_is_announced_gone_and_one_that_returns_is_announced_back() {
        let mut hub = Hub::default();
        let (host, device) = (party(1, Role::Host), party(2, Role::Device));
        hub.attach(host.clone(), &[device.address]);
        hub.attach(device.clone(), &[]);
        heard(&host);

        hub.detach(&device);
        assert_eq!(heard(&host), [presence(&device.address, false)]);
        assert!(!routes(&hub, &host, &device));

        hub.attach(device.clone(), &[]);
        assert_eq!(heard(&host), [presence(&device.address, true)]);
        heard(&device);

        hub.detach(&host);
        assert_eq!(heard(&device), [presence(&host.address, false)]);
        hub.attach(host.clone(), &[device.address]);
        assert_eq!(heard(&device), [presence(&host.address, true)]);
        assert_eq!(hub.size(), 2);
    }

    #[test]
    fn a_newer_connection_replaces_the_older_one_which_then_detaches_as_a_stranger() {
        let mut hub = Hub::default();
        let (host, stale) = (party(1, Role::Host), party(2, Role::Device));
        let fresh =
            Arc::new(Fake { address: stale.address, role: Role::Device, heard: Mutex::default() });
        hub.attach(host.clone(), &[stale.address]);
        hub.attach(stale.clone(), &[]);
        heard(&host);

        hub.attach(fresh.clone(), &[]);
        assert_eq!(heard(&stale), [presence(&host.address, true), "replaced".to_owned()]);

        // The replaced socket closing must not take the new one offline.
        hub.detach(&stale);
        assert!(routes(&hub, &host, &fresh));
        assert!(heard(&host).iter().all(|message| !message.contains("false")));
    }

    #[test]
    fn a_replaced_host_s_listing_goes_with_it_until_the_new_one_lists_again() {
        let mut hub = Hub::default();
        let (old, device) = (party(1, Role::Host), party(2, Role::Device));
        let new =
            Arc::new(Fake { address: old.address, role: Role::Host, heard: Mutex::default() });
        hub.attach(old.clone(), &[device.address]);
        hub.attach(device.clone(), &[]);
        heard(&device);

        hub.attach(new.clone(), &[]);
        assert_eq!(heard(&device), [presence(&old.address, false)]);
        assert!(!routes(&hub, &device, &new));

        hub.set_peers(&new, &[device.address]);
        assert!(routes(&hub, &device, &new));
        heard(&device);

        // The replaced socket can no longer change who the host lists, nor take it offline.
        hub.set_peers(&old, &[]);
        hub.detach(&old);
        assert!(routes(&hub, &device, &new));
        assert_eq!(heard(&device), Vec::<String>::new());
    }

    #[test]
    fn a_device_several_hosts_list_hears_each_and_forgets_each_alone() {
        let mut hub = Hub::default();
        let (studio, laptop) = (party(1, Role::Host), party(3, Role::Host));
        let device = party(2, Role::Device);
        hub.attach(studio.clone(), &[device.address]);
        hub.attach(laptop.clone(), &[device.address]);
        hub.attach(device.clone(), &[]);

        assert_eq!(
            heard(&device),
            [presence(&studio.address, true), presence(&laptop.address, true)]
        );

        hub.detach(&studio);
        assert_eq!(heard(&device), [presence(&studio.address, false)]);
        assert!(routes(&hub, &device, &laptop) && !routes(&hub, &device, &studio));
    }
}
