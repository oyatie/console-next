// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use std::collections::BTreeSet;

use sqlx::PgPool;
use time::{Date, Duration, Weekday, macros::date};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
const DECREE: &str = "관공서의 공휴일에 관한 규정(대통령령 제36290호)";

#[derive(sqlx::FromRow)]
struct Holiday {
    holiday_date: Date,
    name: String,
    kind: String,
    substitute_for: Option<Date>,
    basis: String,
    edition: String,
    article: Option<i32>,
}

// 대통령령 제36290호 §3①1·2·3, ② (overlap), ③ (Saturday substitute).
fn substitutes(base: &[(Date, i32)]) -> Vec<(Date, Date, i32)> {
    let public: BTreeSet<_> = base.iter().map(|(day, _)| *day).collect();
    let mut occupied = public.clone();
    let mut result = Vec::new();
    for &(day, article) in base {
        let weekday = day.weekday();
        let clause = if matches!(article, 2 | 5 | 6 | 7 | 10)
            && matches!(weekday, Weekday::Saturday | Weekday::Sunday)
        {
            1
        } else if matches!(article, 4 | 9) && weekday == Weekday::Sunday {
            2
        } else if matches!(article, 2 | 4 | 5 | 6 | 7 | 9 | 10)
            && !matches!(weekday, Weekday::Saturday | Weekday::Sunday)
            && base.iter().filter(|(other, _)| *other == day).count() > 1
        {
            3
        } else {
            continue;
        };
        let mut next = day + Duration::DAY;
        while matches!(next.weekday(), Weekday::Saturday | Weekday::Sunday)
            || occupied.contains(&next)
        {
            next += Duration::DAY;
        }
        occupied.insert(next);
        result.push((next, day, clause));
    }
    result.sort();
    result
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn official_2027_edition_and_every_substitute_agree_with_the_decree(pool: PgPool) {
    let rows: Vec<Holiday> = sqlx::query_as(
        "SELECT *, substring(basis FROM '제2조 제([0-9]+)호')::integer AS article \
         FROM attendance_public_holidays WHERE holiday_date >= '2027-01-01' \
         AND holiday_date < '2028-01-01' ORDER BY holiday_date",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    // 우주항공청 공고 제2026-0078호, 월력요항 p.4 (read from kasa.go.kr).
    let expected = [
        (date!(2027 - 01 - 01), "1월 1일"),
        (date!(2027 - 02 - 06), "설날 연휴"),
        (date!(2027 - 02 - 07), "설날"),
        (date!(2027 - 02 - 08), "설날 연휴"),
        (date!(2027 - 02 - 09), "설날 대체공휴일"),
        (date!(2027 - 03 - 01), "삼일절"),
        (date!(2027 - 05 - 01), "노동절"),
        (date!(2027 - 05 - 03), "노동절 대체공휴일"),
        (date!(2027 - 05 - 05), "어린이날"),
        (date!(2027 - 05 - 13), "부처님 오신 날"),
        (date!(2027 - 06 - 06), "현충일"),
        (date!(2027 - 07 - 17), "제헌절"),
        (date!(2027 - 07 - 19), "제헌절 대체공휴일"),
        (date!(2027 - 08 - 15), "광복절"),
        (date!(2027 - 08 - 16), "광복절 대체공휴일"),
        (date!(2027 - 09 - 14), "추석 연휴"),
        (date!(2027 - 09 - 15), "추석"),
        (date!(2027 - 09 - 16), "추석 연휴"),
        (date!(2027 - 10 - 03), "개천절"),
        (date!(2027 - 10 - 04), "개천절 대체공휴일"),
        (date!(2027 - 10 - 09), "한글날"),
        (date!(2027 - 10 - 11), "한글날 대체공휴일"),
        (date!(2027 - 12 - 25), "기독탄신일"),
        (date!(2027 - 12 - 27), "기독탄신일 대체공휴일"),
    ];
    assert_eq!(
        rows.iter()
            .map(|h| (h.holiday_date, h.name.as_str()))
            .collect::<Vec<_>>(),
        expected
    );
    let mut base = Vec::new();
    let mut actual = Vec::new();
    for h in &rows {
        assert_eq!(h.edition, "2027");
        assert!(h.basis.starts_with(DECREE), "{}", h.basis);
        if let Some(original) = h.substitute_for {
            assert_eq!(h.kind, "SUBSTITUTE");
            let clause = if h.basis.ends_with("제2호") { 2 } else { 1 };
            assert_eq!(h.basis, format!("{DECREE} 제3조 제1항 제{clause}호"));
            actual.push((h.holiday_date, original, clause));
        } else {
            assert_eq!(
                h.kind,
                if h.name == "노동절" {
                    "LABOR_DAY"
                } else {
                    "NATIONAL"
                }
            );
            let article = match h.name.as_str() {
                "1월 1일" => 3,
                "설날" | "설날 연휴" => 4,
                "부처님 오신 날" => 5,
                "노동절" => 6,
                "어린이날" => 7,
                "현충일" => 8,
                "추석" | "추석 연휴" => 9,
                "기독탄신일" => 10,
                _ => 2,
            };
            assert_eq!(h.article, Some(article));
            base.push((h.holiday_date, article));
        }
    }
    assert_eq!(actual, substitutes(&base));
    assert_eq!(actual.len(), 7);
    let mut red_days: BTreeSet<_> = rows.iter().map(|h| h.holiday_date).collect();
    for day in (0..365).map(|n| date!(2027 - 01 - 01) + Duration::days(n)) {
        if day.weekday() == Weekday::Sunday {
            red_days.insert(day);
        }
    }
    assert_eq!(red_days.len(), 72);
}

#[test]
fn overlapping_holidays_stack_and_saturday_substitutes_move_forward() {
    assert_eq!(
        substitutes(&[(date!(2027 - 05 - 05), 5), (date!(2027 - 05 - 05), 7)]),
        [
            (date!(2027 - 05 - 06), date!(2027 - 05 - 05), 3),
            (date!(2027 - 05 - 07), date!(2027 - 05 - 05), 3),
        ]
    );
    assert_eq!(
        substitutes(&[
            (date!(2027 - 02 - 07), 4),
            (date!(2027 - 02 - 08), 4),
            (date!(2027 - 02 - 09), 4),
            (date!(2027 - 02 - 10), 3),
            (date!(2027 - 02 - 11), 3),
            (date!(2027 - 02 - 12), 3)
        ]),
        [(date!(2027 - 02 - 15), date!(2027 - 02 - 07), 2)]
    );
    assert!(
        substitutes(&[
            (date!(2027 - 01 - 02), 3),
            (date!(2027 - 02 - 06), 4),
            (date!(2027 - 06 - 06), 8),
            (date!(2027 - 09 - 18), 9)
        ])
        .is_empty()
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn corrected_2026_citations_keep_historical_dates_and_rules(pool: PgPool) {
    let expected = [
        (date!(2026 - 01 - 01), "제2조 제3호"),
        (
            date!(2026 - 05 - 01),
            "제2조 제6호 · 노동절 제정에 관한 법률 · 금요일이라 대체 해당 없음",
        ),
        (date!(2026 - 05 - 05), "제2조 제7호"),
        (date!(2026 - 05 - 24), "제2조 제5호"),
        (date!(2026 - 05 - 25), "제3조 제1항 제1호"),
        (date!(2026 - 06 - 03), "제2조 제10호의2"),
        (date!(2026 - 06 - 06), "제2조 제8호 · 대체 없음"),
        (date!(2026 - 07 - 17), "제2조 제2호"),
        (date!(2026 - 08 - 15), "제2조 제2호"),
        (date!(2026 - 08 - 17), "제3조 제1항 제1호"),
        (date!(2026 - 09 - 24), "제2조 제9호"),
        (date!(2026 - 09 - 25), "제2조 제9호"),
        (
            date!(2026 - 09 - 26),
            "제2조 제9호 · 토요일이라 대체 해당 없음",
        ),
        (date!(2026 - 10 - 03), "제2조 제2호"),
        (date!(2026 - 10 - 05), "제3조 제1항 제1호"),
        (date!(2026 - 10 - 09), "제2조 제2호"),
        (date!(2026 - 12 - 25), "제2조 제10호"),
    ];
    for (day, article) in expected {
        let basis: String = sqlx::query_scalar(
            "SELECT basis FROM attendance_public_holidays WHERE holiday_date = $1",
        )
        .bind(day)
        .fetch_one(&pool)
        .await
        .unwrap();
        let instrument = if day < date!(2026 - 05 - 01) {
            "관공서 규정"
        } else {
            DECREE
        };
        assert_eq!(basis, format!("{instrument} {article}"));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM attendance_public_holidays WHERE edition = '2026'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 22);
}
