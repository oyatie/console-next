//! The grounds that let fixed-term service pass the two-year limit:
//! 기간제법 §4① 단서 각 호, with §4①5 split as its 시행령 §3①② split it.
//! A renewal that [`super::fixed_term::check_renewal`] calls `ExceedsLimit`
//! goes through only as a governed `FIXED_TERM_OVER_TWO_YEARS` exception
//! naming one of these. There is no free "기타": §4①6 is the closed 시행령
//! §3③ list.

/// One statutory ground. Wire codes never change once shipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixedTermExemption {
    /// §4①1: 사업의 완료 또는 특정한 업무의 완성에 필요한 기간을 정한 경우.
    ProjectCompletion,
    /// §4①2: 휴직·파견 등으로 결원이 발생하여 복귀할 때까지 대신하는 경우.
    AbsenceCover,
    /// §4①3: 학업, 직업훈련 등을 이수함에 따라 그 이수에 필요한 기간을 정한 경우.
    StudyOrTraining,
    /// §4①4: 고령자고용법 §2(1) 고령자 (55세 이상, 같은 법 시행령 §2①).
    OlderWorker,
    /// §4①5 with 시행령 §3①: 박사 학위, 기술사, 별표 2 전문자격으로 해당 분야 종사.
    Professional,
    /// §4①5 with 시행령 §3②: 정부의 복지정책·실업대책 등에 따른 일자리.
    GovernmentJobProgram,
    /// §4①6 with 시행령 §3③ 1–8호 (다른 법령, 군사·안보, 대학 강사·조교,
    /// 고소득 전문직, 초단시간, 체육, 연구기관 …); the note names the 호.
    DecreeListed,
}

impl FixedTermExemption {
    pub const ALL: [Self; 7] = [
        Self::ProjectCompletion,
        Self::AbsenceCover,
        Self::StudyOrTraining,
        Self::OlderWorker,
        Self::Professional,
        Self::GovernmentJobProgram,
        Self::DecreeListed,
    ];

    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProjectCompletion => "PROJECT_COMPLETION",
            Self::AbsenceCover => "ABSENCE_COVER",
            Self::StudyOrTraining => "STUDY_OR_TRAINING",
            Self::OlderWorker => "OLDER_WORKER",
            Self::Professional => "PROFESSIONAL",
            Self::GovernmentJobProgram => "GOVERNMENT_JOB_PROGRAM",
            Self::DecreeListed => "DECREE_LISTED",
        }
    }

    /// The provision the exception record cites.
    #[must_use]
    pub const fn article(self) -> &'static str {
        match self {
            Self::ProjectCompletion => "기간제법 제4조제1항제1호",
            Self::AbsenceCover => "기간제법 제4조제1항제2호",
            Self::StudyOrTraining => "기간제법 제4조제1항제3호",
            Self::OlderWorker => "기간제법 제4조제1항제4호",
            Self::Professional => "기간제법 제4조제1항제5호, 같은 법 시행령 제3조제1항",
            Self::GovernmentJobProgram => "기간제법 제4조제1항제5호, 같은 법 시행령 제3조제2항",
            Self::DecreeListed => "기간제법 제4조제1항제6호, 같은 법 시행령 제3조제3항",
        }
    }

    /// §4①6 points at a list of eight 호; the record must say which.
    #[must_use]
    pub const fn requires_note(self) -> bool {
        matches!(self, Self::DecreeListed)
    }
}

#[cfg(test)]
mod tests {
    use super::FixedTermExemption as G;

    #[test]
    fn grounds_are_the_six_statutory_items_with_item_five_split() {
        // 기간제법 §4① 단서 1–6호; 5호 splits into 시행령 §3① and §3②.
        let articles = G::ALL.map(G::article);
        for item in 1..=6 {
            let cite = format!("제4조제1항제{item}호");
            assert!(articles.iter().any(|a| a.contains(&cite)), "{cite}");
        }
        assert_eq!(
            articles.iter().filter(|a| a.contains("제1항제5호")).count(),
            2
        );
    }

    #[test]
    fn study_or_training_is_a_ground() {
        // 기간제법 §4①3, missing from the BW-12 draft list.
        assert!(G::ALL.contains(&G::StudyOrTraining));
        assert_eq!(G::StudyOrTraining.code(), "STUDY_OR_TRAINING");
    }

    #[test]
    fn codes_are_unique_and_only_the_decree_list_needs_a_note() {
        let mut codes = G::ALL.map(G::code).to_vec();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 7);
        // 기간제법 §4①6 → 시행령 §3③ 1–8호.
        let noted: Vec<G> = G::ALL.into_iter().filter(|g| g.requires_note()).collect();
        assert_eq!(noted, [G::DecreeListed]);
    }
}
