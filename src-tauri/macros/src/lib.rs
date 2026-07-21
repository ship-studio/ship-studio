//! Macros that give every Ship Studio command two transports from one signature.
//!
//! The desktop app reaches commands through Tauri's IPC; the self-hosted server
//! reaches them over HTTP. Rather than maintain two hand-written dispatch
//! tables — 371 entries that would drift the moment upstream adds a command —
//! [`macro@ship_command`] reads each function's real signature and emits both.
//!
//! ```ignore
//! #[ship_command]
//! #[tracing::instrument]
//! pub async fn commit_changes(project_path: String, message: String)
//!     -> Result<String, CommandError> { … }
//! ```
//!
//! expands to the original function tagged `#[tauri::command]` (unchanged
//! desktop behavior) plus, under `#[cfg(feature = "web")]`, a hidden
//! `__web_commit_changes` module holding a JSON-in/JSON-out handler. The
//! argument struct is derived from the parameter list with the same camelCase
//! convention Tauri uses, so the frontend contract is identical on both
//! transports.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{parse_macro_input, FnArg, Ident, ItemFn, Pat, PatType, ReturnType, Type};

/// Parameter types that only exist in a desktop session. A command taking one
/// can't be served over HTTP as-is, so its web handler reports that rather than
/// failing to compile — Phase 4 replaces these case by case.
const DESKTOP_ONLY_TYPES: &[&str] = &["AppHandle", "Window", "WebviewWindow", "State"];

/// Mark a function as a Ship Studio command.
///
/// Drop-in replacement for `#[tauri::command]`: it re-emits that attribute
/// verbatim, so the desktop build is bit-for-bit unaffected.
#[proc_macro_attribute]
pub fn ship_command(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemFn);
    let web = web_module(&input);
    let expanded = quote! {
        #[tauri::command]
        #input

        #web
    };
    expanded.into()
}

/// Extract `(binding_ident, type)` for each parameter.
fn params(func: &ItemFn) -> Vec<(Ident, &Type)> {
    func.sig
        .inputs
        .iter()
        .filter_map(|arg| match arg {
            FnArg::Typed(PatType { pat, ty, .. }) => match &**pat {
                Pat::Ident(ident) => Some((ident.ident.clone(), &**ty)),
                _ => None,
            },
            // `self` can't appear on a free function; nothing to bind.
            FnArg::Receiver(_) => None,
        })
        .collect()
}

/// Last path segment of a type, e.g. `tauri::AppHandle` -> `AppHandle`.
fn type_name(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(path) => path.path.segments.last().map(|s| s.ident.to_string()),
        _ => None,
    }
}

/// True when the declared return type is a `Result<_, _>`.
fn returns_result(func: &ItemFn) -> bool {
    match &func.sig.output {
        ReturnType::Type(_, ty) => type_name(ty).as_deref() == Some("Result"),
        ReturnType::Default => false,
    }
}

/// Build the `#[cfg(feature = "web")] mod __web_<name>` companion.
fn web_module(func: &ItemFn) -> TokenStream2 {
    let name = &func.sig.ident;
    let name_str = name.to_string();
    let module = format_ident!("__web_{}", name);
    let params = params(func);

    // A command that needs an AppHandle or Window still gets a route, so the
    // frontend receives a structured error it can act on instead of a 404 that
    // looks like a typo.
    if let Some((_, ty)) = params.iter().find(
        |(_, ty)| matches!(type_name(ty).as_deref(), Some(n) if DESKTOP_ONLY_TYPES.contains(&n)),
    ) {
        let ty_name = type_name(ty).unwrap_or_default();
        return quote! {
            #[cfg(feature = "web")]
            #[doc(hidden)]
            #[allow(non_snake_case)]
            pub mod #module {
                pub const NAME: &str = #name_str;
                pub const DESKTOP_ONLY: bool = true;

                pub fn handler(
                    _args: ::serde_json::Value,
                ) -> ::std::pin::Pin<::std::boxed::Box<
                    dyn ::std::future::Future<
                        Output = ::std::result::Result<::serde_json::Value, crate::errors::CommandError>
                    > + Send,
                >> {
                    ::std::boxed::Box::pin(async move {
                        ::std::result::Result::Err(crate::errors::CommandError::Other {
                            message: ::std::format!(
                                "`{}` needs a desktop session (it takes a `{}`) and is not available over HTTP",
                                #name_str,
                                #ty_name,
                            ),
                        })
                    })
                }
            }
        };
    }

    let field_idents: Vec<&Ident> = params.iter().map(|(ident, _)| ident).collect();
    // Accept the snake_case spelling as well as the camelCase one Tauri uses.
    // Costs nothing and means a call site written either way keeps working.
    let field_aliases: Vec<String> = field_idents.iter().map(|i| i.to_string()).collect();

    // A few commands take `&str`. The deserialized struct must own its data, so
    // the field becomes a `String` and the call site re-borrows it.
    let mut field_types: Vec<TokenStream2> = Vec::with_capacity(params.len());
    let mut call_args: Vec<TokenStream2> = Vec::with_capacity(params.len());
    for (ident, ty) in &params {
        match ty {
            Type::Reference(reference) if type_name(&reference.elem).as_deref() == Some("str") => {
                field_types.push(quote! { ::std::string::String });
                call_args.push(quote! { &args.#ident });
            }
            Type::Reference(_) => {
                return syn::Error::new_spanned(
                    ty,
                    "ship_command only supports `&str` among reference parameters; take an owned value instead",
                )
                .to_compile_error();
            }
            _ => {
                field_types.push(quote! { #ty });
                call_args.push(quote! { args.#ident });
            }
        }
    }

    let call = if func.sig.asyncness.is_some() {
        quote! { super::#name( #( #call_args ),* ).await }
    } else {
        quote! { super::#name( #( #call_args ),* ) }
    };

    // `Result<T, E>` propagates through `?` (every command error type in this
    // crate converts into CommandError); a plain `T` is already the value.
    let value = if returns_result(func) {
        quote! { #call ? }
    } else {
        quote! { #call }
    };

    quote! {
        #[cfg(feature = "web")]
        #[doc(hidden)]
        #[allow(non_snake_case, clippy::all)]
        pub mod #module {
            use super::*;

            pub const NAME: &str = #name_str;
            pub const DESKTOP_ONLY: bool = false;

            #[derive(::serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                #( #[serde(alias = #field_aliases)] #field_idents: #field_types, )*
            }

            pub fn handler(
                args: ::serde_json::Value,
            ) -> ::std::pin::Pin<::std::boxed::Box<
                dyn ::std::future::Future<
                    Output = ::std::result::Result<::serde_json::Value, crate::errors::CommandError>
                > + Send,
            >> {
                ::std::boxed::Box::pin(async move {
                    // A `null` body is how a no-argument call arrives; serde
                    // needs an object to deserialize a (possibly empty) struct.
                    let args = if args.is_null() {
                        ::serde_json::Value::Object(::serde_json::Map::new())
                    } else {
                        args
                    };
                    let args: Args = ::serde_json::from_value(args).map_err(|e| {
                        crate::errors::CommandError::Validation {
                            field: #name_str.to_string(),
                            reason: e.to_string(),
                        }
                    })?;
                    let value = #value;
                    ::serde_json::to_value(value).map_err(|e| {
                        crate::errors::CommandError::Other {
                            message: ::std::format!(
                                "failed to serialize the result of `{}`: {}", #name_str, e
                            ),
                        }
                    })
                })
            }
        }
    }
}

/// Expand a list of command paths into HTTP route registrations.
///
/// Takes the same `path::to::command` list the Tauri handler is generated
/// from and rewrites each into its `__web_*` companion, so both transports are
/// driven by one manifest and a command can't be exposed on one and forgotten
/// on the other.
///
/// Expands to an expression of type `Vec<(&'static str, Handler, bool)>`:
/// name, handler, and whether it is desktop-only.
#[proc_macro]
pub fn ship_web_commands(item: TokenStream) -> TokenStream {
    let paths = parse_macro_input!(item with syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated);

    let entries = paths.iter().map(|path| {
        let mut web_path = path.clone();
        // `a::b::c` -> `a::b::__web_c::…`
        if let Some(last) = web_path.segments.last_mut() {
            last.ident = format_ident!("__web_{}", last.ident);
        }
        quote! {
            (
                #web_path::NAME,
                #web_path::handler as crate::web::commands::Handler,
                #web_path::DESKTOP_ONLY,
            )
        }
    });

    quote! { ::std::vec![ #( #entries ),* ] }.into()
}
