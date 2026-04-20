//! mailpouch-tray — native system-tray binding via napi-rs + tauri-apps/tray-icon.
//!
//! Replaces the old `systray2` Go binary that ships with extensionless
//! `/tmp/systray_*` icon files, hardcodes its process name as the
//! StatusNotifierItem `Title`, and never sets `IconThemePath` — three
//! bugs that make GNOME Shell render a "3-dot ellipsis" placeholder
//! instead of our purple-envelope icon.
//!
//! tauri-apps/tray-icon handles all three correctly because it's the
//! same crate Tauri ships in production across thousands of apps.
//! On Linux it uses libayatana-appindicator3 with proper themepath +
//! file-extension hygiene; on macOS it uses NSStatusBar; on Windows
//! it uses the Win32 Shell_NotifyIcon API.
//!
//! ## Threading model
//!
//! `tray-icon` requires an event loop on the thread that owns the tray
//! object — GTK main loop on Linux, NSRunLoop / Cocoa on macOS, Win32
//! message pump on Windows. Node.js runs its own event loop on its
//! main thread and we can't take it over. So we spawn ONE dedicated
//! "tray thread" in Rust, create the tray inside it, and pump native
//! events in a tight loop. Commands from JS (set icon, update menu,
//! quit) are sent over a `crossbeam_channel` to that thread; menu /
//! tray click events go back to JS via a `ThreadsafeFunction`.
//!
//! All public methods on `Tray` are non-blocking from JS's perspective:
//! they enqueue a command and return immediately. The tray thread
//! processes them in order and applies them to the live native widget.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Commands the JS side sends to the tray thread. Each variant maps to
/// one method on the Tray struct below.
enum TrayCommand {
    SetMenu(Vec<MenuItemSpec>),
    SetIcon(Vec<u8>),
    SetTooltip(String),
    Quit,
}

/// Plain Rust copy of the JS-facing menu item spec. `tray-icon`'s menu
/// builders aren't `Send`, so we ferry just the data fields across the
/// channel and reconstruct `MenuItem`s on the tray thread.
#[derive(Clone)]
struct MenuItemSpec {
    id: String,
    label: String,
    enabled: bool,
    separator: bool,
}

/// JS-facing menu item shape — what the wrapper module passes in.
#[napi(object)]
#[derive(Clone)]
pub struct TrayMenuItem {
    /// Stable identifier emitted to the click callback when the user
    /// activates this item. Should not change across menu rebuilds.
    pub id: String,
    /// Visible label in the menu.
    pub label: String,
    /// When false, the item is greyed out and unclickable. Default: true.
    pub enabled: Option<bool>,
    /// When true, treat this entry as a horizontal separator and ignore
    /// all other fields. Default: false.
    pub separator: Option<bool>,
}

/// Public handle — JS keeps one of these alive for the tray's lifetime.
#[napi]
pub struct Tray {
    /// `None` after `destroy()` — guards every method against
    /// post-mortem use.
    cmd_tx: Arc<Mutex<Option<crossbeam_channel::Sender<TrayCommand>>>>,
}

/// Type alias so the (long) ThreadsafeFunction<…> form only appears once.
type ClickTsfn = ThreadsafeFunction<String, ErrorStrategy::Fatal>;

#[napi]
impl Tray {
    /// Construct a tray. The icon and menu can be set later; passing
    /// the initial values here just avoids one round-trip to the tray
    /// thread on the common boot path.
    ///
    /// `on_click` is called with the menu item's `id` whenever the
    /// user activates an item. It's invoked on the Node event loop
    /// thread (via `ThreadsafeFunction`), so JS handlers don't need
    /// to worry about cross-thread state.
    #[napi(constructor)]
    pub fn new(
        icon_png: Buffer,
        tooltip: String,
        items: Vec<TrayMenuItem>,
        on_click: JsFunction,
    ) -> Result<Self> {
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<TrayCommand>();

        // Convert the JS spec into the Send-safe owned form before we
        // hand it to the worker thread.
        let initial_items: Vec<MenuItemSpec> = items
            .into_iter()
            .map(|i| MenuItemSpec {
                id: i.id,
                label: i.label,
                enabled: i.enabled.unwrap_or(true),
                separator: i.separator.unwrap_or(false),
            })
            .collect();

        // Decode the PNG once on the JS thread so we can surface a
        // clear error before we even spawn the worker.
        let initial_icon = decode_png(icon_png.as_ref())?;

        // Build the threadsafe-fn AFTER the input validation so we
        // don't leak a tsfn handle on early-error paths.
        //
        // ErrorStrategy::Fatal means the JS callback receives the
        // value directly as its first argument — `(id) => ...`. The
        // default CalleeHandled strategy invokes the callback Node-
        // style as `(err, value) => ...`, which made our JS handler
        // see `err = null` as the id and silently no-op on every
        // click. Fatal is the right choice for a tray click: there's
        // no recoverable error to surface to JS, and if anything in
        // the Rust-side conversion fails we'd rather crash the
        // worker than swallow the click.
        //
        // The callback converts the Rust String to a JsString
        // explicitly via `ctx.env.create_string`. Without the
        // conversion napi-rs would marshal an undefined value.
        let tsfn: ClickTsfn = on_click.create_threadsafe_function(
            0,
            |ctx: napi::threadsafe_function::ThreadSafeCallContext<String>| {
                ctx.env.create_string(&ctx.value).map(|s| vec![s])
            },
        )?;

        let initial_tooltip = tooltip.clone();

        // Worker thread: owns the native tray; never returns until it
        // receives a `Quit` command (or the channel is dropped).
        thread::spawn(move || {
            run_tray_loop(initial_icon, initial_tooltip, initial_items, cmd_rx, tsfn);
        });

        Ok(Self {
            cmd_tx: Arc::new(Mutex::new(Some(cmd_tx))),
        })
    }

    /// Replace the entire menu. Existing item IDs lose their meaning —
    /// the click callback only knows about IDs in the latest set.
    #[napi]
    pub fn set_menu(&self, items: Vec<TrayMenuItem>) -> Result<()> {
        let specs = items
            .into_iter()
            .map(|i| MenuItemSpec {
                id: i.id,
                label: i.label,
                enabled: i.enabled.unwrap_or(true),
                separator: i.separator.unwrap_or(false),
            })
            .collect();
        self.send(TrayCommand::SetMenu(specs))
    }

    /// Swap the tray icon. Accepts raw PNG bytes (any size; tray-icon
    /// re-rasters to platform-appropriate sizes itself).
    #[napi]
    pub fn set_icon(&self, png: Buffer) -> Result<()> {
        // Decode here so a malformed PNG fails loudly on the JS side
        // rather than silently in the worker thread.
        let bytes = png.as_ref().to_vec();
        // Validate before forwarding — reject early on bad input.
        let _ = decode_png(&bytes)?;
        self.send(TrayCommand::SetIcon(bytes))
    }

    /// Update the hover tooltip text.
    #[napi]
    pub fn set_tooltip(&self, tooltip: String) -> Result<()> {
        self.send(TrayCommand::SetTooltip(tooltip))
    }

    /// Tear down the tray. After `destroy()` every other method on
    /// this handle is a no-op error. Idempotent.
    #[napi]
    pub fn destroy(&self) -> Result<()> {
        let mut guard = self.cmd_tx.lock().map_err(|_| poison_err())?;
        if let Some(tx) = guard.take() {
            // Best-effort send; if the worker is already gone the
            // channel send fails and we just clear our reference.
            let _ = tx.send(TrayCommand::Quit);
        }
        Ok(())
    }

    fn send(&self, cmd: TrayCommand) -> Result<()> {
        let guard = self.cmd_tx.lock().map_err(|_| poison_err())?;
        match guard.as_ref() {
            Some(tx) => tx
                .send(cmd)
                .map_err(|e| Error::new(Status::GenericFailure, format!("tray channel closed: {e}"))),
            None => Err(Error::new(
                Status::Cancelled,
                "tray has been destroyed".to_string(),
            )),
        }
    }
}

fn poison_err() -> Error {
    Error::new(
        Status::GenericFailure,
        "internal: tray command channel mutex poisoned".to_string(),
    )
}

/// Decode the JS-supplied PNG bytes into the RGBA buffer that
/// tray-icon's `Icon::from_rgba` expects. Surfaces a useful error
/// when the input isn't a valid PNG (vs panicking deep in the worker).
fn decode_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| Error::new(Status::InvalidArg, format!("icon must be a valid PNG: {e}")))?;
    let rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();
    Ok((rgba.into_raw(), w, h))
}

/// The actual tray-loop body — runs on a dedicated thread. Owns the
/// native tray for its entire lifetime; tears it down (and exits) when
/// it receives `TrayCommand::Quit` or the channel is closed.
///
/// Pulling this out of `Tray::new` keeps the JS-facing constructor
/// short and makes the platform-specific event-pump easier to read.
fn run_tray_loop(
    initial_icon: (Vec<u8>, u32, u32),
    initial_tooltip: String,
    initial_items: Vec<MenuItemSpec>,
    cmd_rx: crossbeam_channel::Receiver<TrayCommand>,
    tsfn: ClickTsfn,
) {
    use muda::{Menu, MenuEvent, PredefinedMenuItem};
    use std::collections::HashMap;
    use tray_icon::{Icon, TrayIconBuilder};

    // Linux: tray-icon talks to libayatana-appindicator3 which needs
    // GTK initialised on this thread. On macOS / Windows the call is
    // a no-op (gtk crate is not pulled in there per Cargo.toml).
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = gtk::init() {
            eprintln!("[mailpouch-tray] gtk::init failed: {e}");
            return;
        }
    }

    // Build the initial menu and the id-to-spec map we need to ferry
    // ids back out on click events. tray-icon emits MenuId (an opaque
    // string wrapper); we use the JS-supplied id verbatim so JS can
    // look up its own handler.
    let menu = Menu::new();
    let mut id_lookup: HashMap<String, ()> = HashMap::new();
    if let Err(e) = rebuild_menu_into(&menu, &initial_items, &mut id_lookup) {
        eprintln!("[mailpouch-tray] initial menu build failed: {e}");
        return;
    }
    let _ = PredefinedMenuItem::about(None, None); // referenced so muda exports stay live

    // Build the tray. tray-icon's Icon::from_rgba expects raw RGBA
    // (no PNG framing) — we already decoded above.
    let (rgba, w, h) = initial_icon;
    let icon = match Icon::from_rgba(rgba, w, h) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[mailpouch-tray] failed to construct icon: {e}");
            return;
        }
    };

    let tray = TrayIconBuilder::new()
        .with_tooltip(initial_tooltip)
        .with_menu(Box::new(menu.clone()))
        .with_icon(icon)
        .build();
    let mut tray = match tray {
        Ok(t) => Some(t),
        Err(e) => {
            eprintln!("[mailpouch-tray] tray build failed: {e}");
            return;
        }
    };

    let menu_events = MenuEvent::receiver();

    loop {
        // Pump platform-specific event loop briefly so the tray and
        // menu are responsive. On Linux this dispatches GTK events;
        // on macOS / Windows tray-icon uses the relevant native event
        // loop internally and we just need to block-poll our channels.
        #[cfg(target_os = "linux")]
        {
            // Drain pending GTK events without blocking.
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
        }

        // Drain commands from JS — non-blocking; we want to keep
        // pumping native events between command bursts so clicks
        // don't queue up.
        loop {
            match cmd_rx.try_recv() {
                Ok(TrayCommand::Quit) => {
                    drop(tray.take()); // release the tray BEFORE exiting
                    return;
                }
                Ok(TrayCommand::SetMenu(items)) => {
                    let new_menu = Menu::new();
                    let mut new_lookup = HashMap::new();
                    if let Err(e) = rebuild_menu_into(&new_menu, &items, &mut new_lookup) {
                        eprintln!("[mailpouch-tray] menu rebuild failed: {e}");
                        continue;
                    }
                    if let Some(t) = tray.as_ref() {
                        let _ = t.set_menu(Some(Box::new(new_menu.clone())));
                    }
                    id_lookup = new_lookup;
                }
                Ok(TrayCommand::SetIcon(bytes)) => match decode_png(&bytes) {
                    Ok((rgba, w, h)) => match Icon::from_rgba(rgba, w, h) {
                        Ok(icon) => {
                            if let Some(t) = tray.as_ref() {
                                let _ = t.set_icon(Some(icon));
                            }
                        }
                        Err(e) => eprintln!("[mailpouch-tray] icon swap failed: {e}"),
                    },
                    Err(e) => eprintln!("[mailpouch-tray] decode failed during swap: {e}"),
                },
                Ok(TrayCommand::SetTooltip(s)) => {
                    if let Some(t) = tray.as_ref() {
                        let _ = t.set_tooltip(Some(s));
                    }
                }
                Err(crossbeam_channel::TryRecvError::Empty) => break,
                Err(crossbeam_channel::TryRecvError::Disconnected) => {
                    drop(tray.take());
                    return;
                }
            }
        }

        // Drain menu events fired by user interaction. Each event
        // carries a MenuId we can convert back to the JS id. We
        // forward via tsfn — JS owns the dispatch table.
        while let Ok(ev) = menu_events.try_recv() {
            let id = ev.id().0.clone();
            if id_lookup.contains_key(&id) {
                // ErrorStrategy::Fatal — pass the value directly, not Ok(...).
                tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
        // Drain tray-icon events (left-click on icon, etc.) so they
        // don't pile up indefinitely on the crossbeam channel. We
        // don't forward them to JS yet; add a second tsfn here when
        // a use case appears (e.g. "left-click the icon, open
        // settings immediately without showing the menu").
        while tray_icon::TrayIconEvent::receiver().try_recv().is_ok() { /* drop */ }
        // Sleep briefly to avoid busy-looping. 50 ms gives a
        // perceptually instant click response while keeping the
        // worker idle most of the time.
        thread::sleep(Duration::from_millis(50));
    }
}

fn rebuild_menu_into(
    menu: &muda::Menu,
    items: &[MenuItemSpec],
    id_lookup: &mut std::collections::HashMap<String, ()>,
) -> std::result::Result<(), String> {
    use muda::{MenuId, MenuItem, PredefinedMenuItem};
    for spec in items {
        if spec.separator {
            menu.append(&PredefinedMenuItem::separator())
                .map_err(|e| format!("append separator: {e}"))?;
            continue;
        }
        let item = MenuItem::with_id(MenuId::new(&spec.id), &spec.label, spec.enabled, None);
        menu.append(&item)
            .map_err(|e| format!("append {}: {e}", spec.id))?;
        id_lookup.insert(spec.id.clone(), ());
    }
    Ok(())
}
