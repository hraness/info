use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{self, Read};
use std::net::{IpAddr, SocketAddr};
use std::ptr::null_mut;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use metadata_search_engine_rs::{
    aggregator::aggregate,
    engines::{
        BraveEngine, DuckDuckGoEngine, SearchEngine, StartpageEngine, YahooEngine,
    },
    models::SearchResponse,
};
use reqwest::{
    Client,
    header::{self, HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde::Deserialize;

const MAX_INPUT_BYTES: u64 = 16 * 1024;
const MAX_QUERY_BYTES: usize = 4 * 1024;
const MAX_RESULTS: usize = 20;
const MIN_TIMEOUT_MS: u64 = 500;
const MAX_TIMEOUT_MS: u64 = 15_000;
const MAX_ENGINE_ADDRESSES: usize = 8;
#[cfg(target_os = "linux")]
const PROCESS_DATA_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
const TRACKED_HEAP_LIMIT_BYTES: usize = 128 * 1024 * 1024;
const ENGINE_HOSTS: [&str; 4] = [
    "html.duckduckgo.com",
    "search.brave.com",
    "www.startpage.com",
    "search.yahoo.com",
];

struct BoundedAllocator;

static TRACKED_HEAP_BYTES: AtomicUsize = AtomicUsize::new(0);

fn reserve_heap(bytes: usize) -> bool {
    let mut current = TRACKED_HEAP_BYTES.load(Ordering::Relaxed);
    loop {
        let Some(next) = current.checked_add(bytes) else {
            return false;
        };
        if next > TRACKED_HEAP_LIMIT_BYTES {
            return false;
        }
        match TRACKED_HEAP_BYTES.compare_exchange_weak(
            current,
            next,
            Ordering::AcqRel,
            Ordering::Relaxed,
        ) {
            Ok(_) => return true,
            Err(observed) => current = observed,
        }
    }
}

fn release_heap(bytes: usize) {
    TRACKED_HEAP_BYTES.fetch_sub(bytes, Ordering::AcqRel);
}

// Every Rust-owned response buffer, parsed DOM, and result object passes
// through this allocator. Native-library process data is additionally bounded
// through RLIMIT_DATA where the host kernel supports lowering it (Linux).
unsafe impl GlobalAlloc for BoundedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !reserve_heap(layout.size()) {
            return null_mut();
        }
        // SAFETY: the system allocator receives the caller's valid layout.
        let pointer = unsafe { System.alloc(layout) };
        if pointer.is_null() {
            release_heap(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !reserve_heap(layout.size()) {
            return null_mut();
        }
        // SAFETY: the system allocator receives the caller's valid layout.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if pointer.is_null() {
            release_heap(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: the pointer and layout came from this allocator.
        unsafe { System.dealloc(pointer, layout) };
        release_heap(layout.size());
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // Conservatively reserve the complete replacement before asking the
        // system allocator to grow or move the old allocation.
        if !reserve_heap(new_size) {
            return null_mut();
        }
        // SAFETY: the pointer and old layout came from this allocator.
        let replacement = unsafe { System.realloc(pointer, layout, new_size) };
        if replacement.is_null() {
            release_heap(new_size);
        } else {
            release_heap(layout.size());
        }
        replacement
    }
}

#[global_allocator]
static GLOBAL_ALLOCATOR: BoundedAllocator = BoundedAllocator;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolvedAddress {
    address: String,
    family: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EngineHost {
    hostname: String,
    addresses: Vec<ResolvedAddress>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    schema_version: u8,
    query: String,
    max_results: usize,
    timeout_ms: u64,
    engine_hosts: Vec<EngineHost>,
}

fn read_request() -> Result<SearchRequest, &'static str> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "stdin-read")?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("input-too-large");
    }
    let request: SearchRequest = serde_json::from_slice(&bytes).map_err(|_| "invalid-json")?;
    if request.schema_version != 1 {
        return Err("unsupported-schema");
    }
    if request.query.trim().is_empty() || request.query.as_bytes().len() > MAX_QUERY_BYTES {
        return Err("invalid-query");
    }
    if request.max_results == 0 || request.max_results > MAX_RESULTS {
        return Err("invalid-result-limit");
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
        return Err("invalid-timeout");
    }
    if request.engine_hosts.len() != ENGINE_HOSTS.len() {
        return Err("invalid-engine-hosts");
    }
    for (host, expected) in request.engine_hosts.iter().zip(ENGINE_HOSTS) {
        if host.hostname != expected
            || host.addresses.is_empty()
            || host.addresses.len() > MAX_ENGINE_ADDRESSES
        {
            return Err("invalid-engine-hosts");
        }
    }
    Ok(request)
}

fn fail(code: &'static str) -> ! {
    eprintln!("metadata search failed: {code}");
    std::process::exit(2);
}

#[cfg(target_os = "linux")]
fn constrain_process_memory() -> Result<(), &'static str> {
    let limit = libc::rlimit {
        rlim_cur: PROCESS_DATA_LIMIT_BYTES as libc::rlim_t,
        rlim_max: PROCESS_DATA_LIMIT_BYTES as libc::rlim_t,
    };
    // SAFETY: `limit` is fully initialized and lowering these process-local
    // resource ceilings cannot grant privileges or affect the parent.
    unsafe {
        if libc::setrlimit(libc::RLIMIT_DATA, &limit) != 0 {
            return Err("memory-limit-data");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn constrain_process_memory() -> Result<(), &'static str> {
    Ok(())
}

fn is_private_or_reserved(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 0 || b == 168))
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224
        }
        IpAddr::V6(address) => {
            let groups = address.segments();
            let ipv4_compatible = groups[..6].iter().all(|group| *group == 0);
            let ipv4_mapped = groups[..5].iter().all(|group| *group == 0)
                && groups[5] == 0xffff;
            if ipv4_compatible || ipv4_mapped {
                let high = groups[6];
                let low = groups[7];
                let embedded = std::net::Ipv4Addr::new(
                    (high >> 8) as u8,
                    high as u8,
                    (low >> 8) as u8,
                    low as u8,
                );
                return is_private_or_reserved(IpAddr::V4(embedded));
            }
            let first = groups[0];
            let second = groups[1];
            (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xffc0) == 0xfec0
                || (first & 0xff00) == 0xff00
                || first == 0x0064
                || first == 0x0100
                || (first == 0x2001 && second <= 0x01ff)
                || (first == 0x2001 && second == 0x0db8)
                || first == 0x2002
                || first == 0x3ffe
                || (first == 0x3fff && (second & 0xf000) == 0)
                || first == 0x5f00
        }
    }
}

fn global_socket_addresses(host: &EngineHost) -> Result<Vec<SocketAddr>, &'static str> {
    let mut addresses = Vec::with_capacity(host.addresses.len());
    for input in &host.addresses {
        let address = input
            .address
            .parse::<IpAddr>()
            .map_err(|_| "invalid-engine-address")?;
        let family = if address.is_ipv4() { 4 } else { 6 };
        if family != input.family || is_private_or_reserved(address) {
            return Err("invalid-engine-address");
        }
        let socket = SocketAddr::new(address, 443);
        if addresses.contains(&socket) {
            return Err("invalid-engine-address");
        }
        addresses.push(socket);
    }
    Ok(addresses)
}

fn build_pinned_http_client(
    hosts: &[EngineHost],
    timeout: Duration,
) -> Result<Client, &'static str> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/124.0.0.0 Safari/537.36",
        ),
    );
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ),
    );
    headers.insert(
        header::ACCEPT_LANGUAGE,
        HeaderValue::from_static("en-US,en;q=0.9"),
    );
    headers.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("gzip, deflate, br"),
    );
    headers.insert("DNT", HeaderValue::from_static("1"));
    headers.insert("Sec-Fetch-Dest", HeaderValue::from_static("document"));
    headers.insert("Sec-Fetch-Mode", HeaderValue::from_static("navigate"));
    headers.insert("Sec-Fetch-Site", HeaderValue::from_static("none"));
    headers.insert("Sec-Fetch-User", HeaderValue::from_static("?1"));

    let mut builder = Client::builder()
        .default_headers(headers)
        .cookie_store(true)
        .gzip(true)
        .brotli(true)
        .redirect(Policy::none())
        .timeout(timeout);
    for host in hosts {
        let addresses = global_socket_addresses(host)?;
        builder = builder.resolve_to_addrs(&host.hostname, &addresses);
    }
    builder.build().map_err(|_| "http-client")
}

fn main() {
    if let Err(code) = constrain_process_memory() {
        fail(code);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|_| fail("runtime"));
    runtime.block_on(run());
}

async fn run() {
    let request = match read_request() {
        Ok(request) => request,
        Err(code) => fail(code),
    };
    let timeout = Duration::from_millis(request.timeout_ms / ENGINE_HOSTS.len() as u64);
    let client = Arc::new(
        build_pinned_http_client(&request.engine_hosts, timeout)
            .unwrap_or_else(|code| fail(code)),
    );
    let engines: Vec<Arc<dyn SearchEngine>> = vec![
        Arc::new(DuckDuckGoEngine::with_timeout(Arc::clone(&client), timeout)),
        Arc::new(BraveEngine::with_timeout(Arc::clone(&client), timeout)),
        Arc::new(StartpageEngine::with_timeout(Arc::clone(&client), timeout)),
        Arc::new(YahooEngine::with_timeout(Arc::clone(&client), timeout)),
    ];
    let engines_queried = engines
        .iter()
        .map(|engine| engine.name().to_string())
        .collect::<Vec<_>>();
    let mut successes = Vec::new();
    let mut engines_failed = Vec::new();
    // Run one upstream engine at a time so its unbounded internal `text()`
    // allocation is contained by the process memory ceiling rather than
    // multiplied across four concurrent responses.
    for engine in &engines {
        let name = engine.name().to_string();
        match engine
            .search(request.query.trim(), request.max_results)
            .await
        {
            Ok(results) => successes.push((name, results)),
            Err(_) => engines_failed.push(name),
        }
    }
    let mut results = aggregate(successes, request.max_results);
    results.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.url.cmp(&right.url))
    });
    let response = SearchResponse {
        query: request.query.trim().to_string(),
        results,
        engines_queried,
        engines_failed,
    };
    if serde_json::to_writer(io::stdout().lock(), &response).is_err() {
        fail("stdout-write");
    }
}
