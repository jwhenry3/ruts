use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Instant;

// ---------- Error ----------

#[derive(Debug, Clone)]
pub struct Error {
    pub status: u16,
    pub message: String,
}

impl Error {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Error { status, message: message.into() }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Error {}

pub fn bad_request(msg: impl Into<String>) -> Error { Error::new(400, msg) }
pub fn unauthorized(msg: impl Into<String>) -> Error { Error::new(401, msg) }
pub fn forbidden(msg: impl Into<String>) -> Error { Error::new(403, msg) }
pub fn not_found(msg: impl Into<String>) -> Error { Error::new(404, msg) }
pub fn conflict(msg: impl Into<String>) -> Error { Error::new(409, msg) }
pub fn internal(msg: impl Into<String>) -> Error { Error::new(500, msg) }

pub fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

// ---------- DTO validation ----------

pub trait Validatable {
    fn validate(&self) -> Result<(), Error>;
}

// ---------- Ctx ----------

pub struct Ctx {
    pub method: String,
    pub path: String,
    params: HashMap<String, String>,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    pub body: Value,
    status: u16,
    views_glob: String,
}

impl Ctx {
    pub fn param(&self, key: &str) -> String {
        self.params.get(key).cloned().unwrap_or_default()
    }

    pub fn param_int(&self, key: &str) -> (i32, Option<Error>) {
        match self.param(key).parse::<i32>() {
            Ok(v) => (v, None),
            Err(_) => (0, Some(bad_request(format!("param '{}' must be an integer", key)))),
        }
    }

    pub fn query(&self, key: &str) -> String {
        self.query.get(key).cloned().unwrap_or_default()
    }

    pub fn header(&self, key: &str) -> String {
        self.headers.get(&key.to_ascii_lowercase()).cloned().unwrap_or_default()
    }

    pub fn status(&mut self, code: u16) {
        self.status = code;
    }

    pub fn json(&mut self, v: Value) -> Result<Value, Error> {
        Ok(v)
    }

    pub fn render(&mut self, name: &str) -> Result<Value, Error> {
        match load_view(&self.views_glob, name) {
            Some(html) => Ok(Value::String(format!("__html__{}", html))),
            None => Err(not_found(format!("view '{}' not found", name))),
        }
    }
}

fn load_view(glob: &str, name: &str) -> Option<String> {
    // glob like "views/*.html" resolved against CWD, then ancestors
    let dir_part = glob.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let candidate = dir.join(dir_part);
        if candidate.is_dir() {
            let file = candidate.join(format!("{}.html", name));
            if let Ok(s) = std::fs::read_to_string(&file) {
                return Some(s);
            }
        }
        if !dir.pop() { return None; }
    }
}

// ---------- Guards / Interceptors ----------

pub trait Guard: Send + Sync {
    fn check(&self, ctx: &Ctx) -> bool;
}

pub trait Interceptor: Send + Sync {
    fn intercept(&self, ctx: &Ctx);
}

// ---------- Controller / routes ----------

pub type Handler = Arc<dyn Fn(&mut Ctx, Value) -> Result<Value, Error> + Send + Sync>;

struct Route {
    method: &'static str,
    path: String,
    handler: Handler,
    guards: Vec<Arc<dyn Guard>>,
}

pub struct WithGuard(pub Arc<dyn Guard>);
pub struct WithInterceptor(pub Arc<dyn Interceptor>);

pub fn with_guard<G: Guard + 'static>(g: G) -> WithGuard { WithGuard(Arc::new(g)) }
pub fn with_interceptor<I: Interceptor + 'static>(i: I) -> WithInterceptor { WithInterceptor(Arc::new(i)) }

pub struct Controller {
    prefix: String,
    interceptors: Vec<Arc<dyn Interceptor>>,
    routes_guard: Vec<Arc<dyn Guard>>,
    routes: Vec<Route>,
}

impl Controller {
    pub fn new(prefix: &str) -> Self {
        Controller { prefix: prefix.to_string(), interceptors: vec![], routes_guard: vec![], routes: vec![] }
    }

    pub fn interceptor<I: Interceptor + 'static>(mut self, i: I) -> Self {
        self.interceptors.push(Arc::new(i));
        self
    }

    pub fn guard<G: Guard + 'static>(mut self, g: G) -> Self {
        // class-level guard applies to every route added later — store as route default
        self.routes_guard.push(Arc::new(g));
        self
    }

    fn add(&mut self, method: &'static str, path: &str, h: Handler, opts: Vec<WithGuard>) {
        let mut guards = self.routes_guard.clone();
        for o in opts { guards.push(o.0); }
        self.routes.push(Route { method, path: path.to_string(), handler: h, guards });
    }

    pub fn get(mut self, path: &str, h: Handler) -> Self { self.add("GET", path, h, vec![]); self }
    pub fn post(mut self, path: &str, h: Handler) -> Self { self.add("POST", path, h, vec![]); self }
    pub fn patch(mut self, path: &str, h: Handler) -> Self { self.add("PATCH", path, h, vec![]); self }
    pub fn delete(mut self, path: &str, h: Handler) -> Self { self.add("DELETE", path, h, vec![]); self }

    pub fn get_g(mut self, path: &str, h: Handler, g: WithGuard) -> Self { self.add("GET", path, h, vec![g]); self }
    pub fn delete_g(mut self, path: &str, h: Handler, g: WithGuard) -> Self { self.add("DELETE", path, h, vec![g]); self }
    pub fn post_g(mut self, path: &str, h: Handler, g: WithGuard) -> Self { self.add("POST", path, h, vec![g]); self }
    pub fn patch_g(mut self, path: &str, h: Handler, g: WithGuard) -> Self { self.add("PATCH", path, h, vec![g]); self }
}

// ---------- dependency registry (generated module factories share it) ----------

#[derive(Default)]
pub struct Deps {
    map: HashMap<std::any::TypeId, Arc<dyn std::any::Any + Send + Sync>>,
}

impl Deps {
    pub fn new() -> Self { Deps::default() }

    pub fn register<T: Send + Sync + 'static>(&mut self, v: Arc<T>) {
        self.map.insert(std::any::TypeId::of::<T>(), v);
    }

    pub fn get<T: Send + Sync + 'static>(&self) -> Arc<T> {
        self.map
            .get(&std::any::TypeId::of::<T>())
            .and_then(|a| a.clone().downcast::<T>().ok())
            .unwrap_or_else(|| panic!("deps: no provider for {}", std::any::type_name::<T>()))
    }
}

// ---------- Module / App ----------

pub struct Module {
    #[allow(dead_code)]
    name: String,
    controllers: Vec<Controller>,
    modules: Vec<Module>,
}

impl Module {
    pub fn new(name: &str) -> Self {
        Module { name: name.to_string(), controllers: vec![], modules: vec![] }
    }

    pub fn controller(mut self, c: Controller) -> Self {
        self.controllers.push(c);
        self
    }

    pub fn import(mut self, m: Module) -> Self {
        self.modules.push(m);
        self
    }

    pub fn provider<F>(self, _f: F) -> Self { self }
    pub fn export<F>(self, _f: F) -> Self { self }
}

pub struct App {
    module: Module,
    prefix: String,
    views_glob: String,
}

pub fn create(m: Module) -> App {
    App { module: m, prefix: String::new(), views_glob: "views/*.html".to_string() }
}

impl App {
    pub fn set_global_prefix(&mut self, p: &str) {
        self.prefix = p.trim_end_matches('/').to_string();
    }

    pub fn set_views(&mut self, glob: &str) {
        self.views_glob = glob.to_string();
    }

    pub fn listen(&self, port: impl AsRef<str>) {
        let routes = collect_routes(&self.module, &self.prefix);
        let addr = format!("127.0.0.1:{}", port.as_ref().trim_start_matches(':'));
        let listener = TcpListener::bind(&addr).expect("failed to bind");
        println!("listening on http://{}", addr);
        let routes = Arc::new(routes);
        let views = Arc::new(self.views_glob.clone());
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                let routes = routes.clone();
                let views = views.clone();
                std::thread::spawn(move || handle_conn(stream, routes, views));
            }
        }
    }
}

struct FlatRoute {
    method: &'static str,
    segments: Vec<String>,
    handler: Handler,
    guards: Vec<Arc<dyn Guard>>,
    interceptors: Vec<Arc<dyn Interceptor>>,
}

fn collect_routes(m: &Module, prefix: &str) -> Vec<FlatRoute> {
    let mut out = vec![];
    for sub in &m.modules {
        out.extend(collect_routes(sub, prefix));
    }
    for c in &m.controllers {
        for r in &c.routes {
            let full = format!("{}{}{}", prefix, c.prefix, r.path);
            let segments: Vec<String> = full
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            out.push(FlatRoute {
                method: r.method,
                segments,
                handler: r.handler.clone(),
                guards: r.guards.clone(),
                interceptors: c.interceptors.clone(),
            });
        }
    }
    out
}

// ---------- HTTP plumbing ----------

fn handle_conn(mut stream: TcpStream, routes: Arc<Vec<FlatRoute>>, views: Arc<String>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() { return; }
    let mut parts = request_line.trim().split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut headers = HashMap::new();
    let mut content_len = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() { break; }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            if key == "content-length" { content_len = val.parse().unwrap_or(0); }
            headers.insert(key, val);
        }
    }

    let mut body_bytes = vec![0u8; content_len];
    let _ = reader.read_exact(&mut body_bytes);
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);

    let (path, query) = split_query(&target);
    let path_segs: Vec<String> = path.split('/').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();

    let mut matched: Option<(&FlatRoute, HashMap<String, String>)> = None;
    for r in routes.iter() {
        if r.method != method { continue; }
        if let Some(params) = match_segments(&r.segments, &path_segs) {
            matched = Some((r, params));
            break;
        }
    }

    let (status, body_out): (u16, String) = match matched {
        Some((route, params)) => {
            let mut ctx = Ctx {
                method, path, params, query, headers, body,
                status: 200, views_glob: views.to_string(),
            };
            for g in &route.guards {
                if !g.check(&ctx) {
                    let e = unauthorized("unauthorized");
                    return respond(&mut stream, e.status, &err_body(&e));
                }
            }
            let start = Instant::now();
            for i in &route.interceptors { i.intercept(&ctx); }
            let body_arg = ctx.body.clone();
            let result = (route.handler)(&mut ctx, body_arg);
            let _elapsed = start.elapsed();
            match result {
                Ok(v) => {
                    if let Value::String(t) = &v {
                        if let Some(html) = t.strip_prefix("__html__") {
                            return respond_html(&mut stream, ctx.status, html);
                        }
                    }
                    let s = if v.is_null() { String::new() } else { v.to_string() };
                    (ctx.status, s)
                }
                Err(e) => (e.status, err_body(&e)),
            }
        }
        None => {
            let e = not_found("not found");
            (e.status, err_body(&e))
        }
    };

    respond(&mut stream, status, &body_out);
}

fn err_body(e: &Error) -> String {
    serde_json::json!({"statusCode": e.status, "message": e.message}).to_string()
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let text = status_text(status);
    let out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status, text, body.len(), body
    );
    let _ = stream.write_all(out.as_bytes());
}

fn respond_html(stream: &mut TcpStream, status: u16, html: &str) {
    let text = status_text(status);
    let out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status, text, html.len(), html
    );
    let _ = stream.write_all(out.as_bytes());
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK", 201 => "Created", 204 => "No Content",
        400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden",
        404 => "Not Found", 409 => "Conflict", 500 => "Internal Server Error",
        _ => "OK",
    }
}

fn split_query(target: &str) -> (String, HashMap<String, String>) {
    let mut q = HashMap::new();
    match target.split_once('?') {
        Some((p, qs)) => {
            for pair in qs.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    q.insert(k.to_string(), v.to_string());
                }
            }
            (p.to_string(), q)
        }
        None => (target.to_string(), q),
    }
}

fn match_segments(route: &[String], path: &[String]) -> Option<HashMap<String, String>> {
    if route.len() != path.len() { return None; }
    let mut params = HashMap::new();
    for (r, p) in route.iter().zip(path.iter()) {
        if r.starts_with('{') && r.ends_with('}') {
            params.insert(r[1..r.len() - 1].to_string(), p.clone());
        } else if r != p {
            return None;
        }
    }
    Some(params)
}

// ---------- channels (std::sync::mpsc) ----------

use std::sync::mpsc::{channel, Iter, Receiver, Sender};

/// Chan<T> — owns both ends of an mpsc channel.
/// `tx.send` / `rx.recv` / `rx.iter` are reached via field access;
/// `close()` drops the sender so `rx.iter()` can terminate.
pub struct Chan<T> {
    pub tx: Sender<T>,
    pub rx: Receiver<T>,
}

impl<T> Chan<T> {
    pub fn send(&self, v: T) -> Result<(), std::sync::mpsc::SendError<T>> {
        self.tx.send(v)
    }
    pub fn recv(&self) -> Result<T, std::sync::mpsc::RecvError> {
        self.rx.recv()
    }
    pub fn iter(&self) -> Iter<'_, T> {
        self.rx.iter()
    }
}

pub fn chan<T>() -> Chan<T> {
    let (tx, rx) = channel();
    Chan { tx, rx }
}
