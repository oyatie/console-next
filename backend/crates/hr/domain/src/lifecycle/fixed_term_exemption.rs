//! The grounds that let fixed-term service pass the two-year limit: each item
//! of the Fixed-Term Workers Act §4① proviso, with §4①5 split as its
//! Enforcement Decree §3①② split it.
//! A renewal that [`super::fixed_term::check_renewal`] calls `ExceedsLimit`
//! goes through only as a governed `FIXED_TERM_OVER_TWO_YEARS` exception
//! naming one of these. There is no free "Other": §4①6 is the closed
//! Enforcement Decree §3③ list.

/// One statutory ground. Wire codes never change once shipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixedTermExemption {
    /// §4①1: where the period needed to complete a business or a specific task
    /// is fixed.
    ProjectCompletion,
    /// §4①2: where a vacancy arises from a leave of absence, dispatch, etc. and
    /// someone fills in until the absent worker returns.
    AbsenceCover,
    /// §4①3: where the period needed to complete studies, vocational training,
    /// etc. is fixed.
    StudyOrTraining,
    /// §4①4: an aged person under Aged Employment Act §2(1) (aged 55 or over,
    /// Enforcement Decree §2① of the same Act).
    OlderWorker,
    /// §4①5 with Enforcement Decree §3①: a doctoral degree, a professional
    /// engineer qualification or an Annex Table 2 professional qualification,
    /// working in that field.
    Professional,
    /// §4①5 with Enforcement Decree §3②: jobs under government welfare
    /// policies, unemployment measures, etc.
    GovernmentJobProgram,
    /// §4①6 with Enforcement Decree §3③ items 1–8 (other statutes, military ·
    /// security, university lecturers · teaching assistants, high-income
    /// professionals, very short hours, sports, research institutes …); the
    /// note names the item.
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

    /// §4①6 points at a list of eight items; the record must say which.
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
        // Fixed-Term Workers Act §4① proviso items 1–6; item 5 splits into
        // Enforcement Decree §3① and §3②.
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
        // Fixed-Term Workers Act §4①3, missing from the BW-12 draft list.
        assert!(G::ALL.contains(&G::StudyOrTraining));
        assert_eq!(G::StudyOrTraining.code(), "STUDY_OR_TRAINING");
    }

    #[test]
    fn codes_are_unique_and_only_the_decree_list_needs_a_note() {
        let mut codes = G::ALL.map(G::code).to_vec();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 7);
        // Fixed-Term Workers Act §4①6 → Enforcement Decree §3③ items 1–8.
        let noted: Vec<G> = G::ALL.into_iter().filter(|g| g.requires_note()).collect();
        assert_eq!(noted, [G::DecreeListed]);
    }
}
