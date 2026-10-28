//! What counts as a code line.

fn code_lines(text: &str) -> usize {
    console_gate_file_size::count::code_lines("src/lib.rs", text)
}

#[test]
fn blank_lines_and_every_comment_form_are_not_code() {
    let src = r#"//! crate doc
/*! inner block doc */

/// item doc
/** block doc
    spanning lines */
// line comment
/* block
   comment */
fn a() {}

"#;
    assert_eq!(code_lines(src), 1);
}

#[test]
fn every_line_of_a_multi_line_token_is_code() {
    let src = "const Q: &str = \"\n  SELECT 1\n  FROM t\n\";\n";
    assert_eq!(code_lines(src), 4);
}

#[test]
fn a_lone_closing_brace_is_code() {
    assert_eq!(code_lines("fn a() {\n    let x = 1;\n}\n"), 3);
}

#[test]
fn inline_test_items_are_excluded_at_any_depth() {
    let src = r#"fn shipped() {}

#[cfg(test)]
mod tests {
    #[test]
    fn t() {}
}

mod inner {
    pub struct S;
    impl S {
        #[cfg(all(test, feature = "x"))]
        fn only_tests(&self) {}
        pub fn shipped(&self) {}
    }
    pub trait T {
        #[cfg(test)]
        fn probe() {}
    }
}
"#;
    // shipped, mod inner {, struct, impl {, fn shipped, }, trait {, }, }
    assert_eq!(code_lines(src), 9);
}

#[test]
fn cfg_that_can_ship_is_counted() {
    for cfg in [
        "any(test, feature = \"x\")",
        "not(test)",
        "feature = \"test-utils\"",
    ] {
        let src = format!("#[cfg({cfg})]\nfn f() {{}}\n");
        assert_eq!(code_lines(&src), 2, "{cfg}");
    }
}

#[test]
fn a_file_that_does_not_lex_counts_every_non_blank_line() {
    assert_eq!(code_lines("fn a() {\n// x\n\n"), 2);
}

#[test]
fn a_file_that_does_not_parse_keeps_its_test_items() {
    assert_eq!(code_lines("#[cfg(test)]\nmod t {}\nfn ();\n"), 3);
}

// The textual scanner: literals and comments must not fool the lexer or the
// test-item scan.

#[test]
fn raw_strings_hide_comment_markers_attributes_and_braces() {
    let src =
        "const A: &str = r#\"\n#[cfg(test)] mod t { // }\n\"#;\nconst B: &str = \"/* \\\" }\";\n";
    assert_eq!(code_lines(src), 4);
}

#[test]
fn lifetimes_and_char_literals_lex() {
    let src =
        "fn f<'a>(x: &'a str) -> char {\n    let _ = ['\"', '\\'', '{', b'}'];\n    '\\u{7b}'\n}\n";
    assert_eq!(code_lines(src), 4);
}

#[test]
fn nested_block_comments_are_not_code() {
    assert_eq!(
        code_lines("/* a /* b */\n still comment */\nfn a() {}\n"),
        1
    );
}

#[test]
fn test_items_without_a_block_end_at_their_semicolon() {
    let src = "#[cfg(test)]\nmod tests;\n#[cfg(test)]\nuse std::fmt;\n#[cfg(test)]\n#[derive(Debug)]\nstruct S(u8);\nfn shipped() {}\n";
    assert_eq!(code_lines(src), 1);
}

#[test]
fn test_gated_fields_and_variants_are_excluded() {
    let src = "struct S {\n    a: u8,\n    #[cfg(test)]\n    b: u8,\n    #[cfg(test)]\n    c: u8\n}\nenum E {\n    #[cfg(test)]\n    V { x: u8 },\n    W,\n}\n";
    // struct {, a, }, enum {, W, }
    assert_eq!(code_lines(src), 6);
}

#[test]
fn a_const_block_item_takes_its_trailing_semicolon() {
    let src = "#[cfg(test)]\nconst X: [u8; 1] = {\n    [0]\n}\n;\nfn shipped() {}\n";
    assert_eq!(code_lines(src), 1);
}

#[test]
fn inner_cfg_test_and_attribute_like_text_in_comments_are_counted() {
    let src = "#![cfg(test)]\n// #[cfg(test)]\nfn a() {}\n";
    assert_eq!(code_lines(src), 2);
}

#[test]
fn unterminated_literals_and_comments_count_every_non_blank_line() {
    for src in [
        "fn a() {}\n/* open\n\n",
        "const S: &str = \"open\n\n",
        "fn a() { )\n",
    ] {
        assert_eq!(
            code_lines(src),
            src.lines().filter(|l| !l.trim().is_empty()).count(),
            "{src}"
        );
    }
}
