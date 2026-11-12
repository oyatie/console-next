-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Refuse new non-ISO nationality writes; retain and report existing unknowns.
-- contract-of: 0294
-- Source: ISO 3166-1 alpha-2, https://www.iso.org/iso-3166-country-codes.html
-- Codes cross-checked with UNSD M49 https://unstats.un.org/unsd/methodology/m49/overview/
-- (248 entries) plus ISO TW https://www.iso.org/obp/ui/#iso:code:3166:TW .
-- Display translations: Unicode CLDR 48 (Unicode-3.0), ko/en territories.json:
-- https://github.com/unicode-org/cldr-json/tree/48.0.0/cldr-json/cldr-localenames-full/main
-- valid_from below is this catalog snapshot's effective date, not the country's ISO assignment date.
-- Intervals are [valid_from, valid_to); reference catalogs are global, public data, read-only at runtime.
SET LOCAL lock_timeout = '2s';

CREATE TABLE country_codes (
    code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$')
);
CREATE TABLE country_code_versions (
    code TEXT NOT NULL,
    label_ko TEXT NOT NULL CHECK (btrim(label_ko) <> ''),
    label_en TEXT NOT NULL CHECK (btrim(label_en) <> ''),
    search_terms TEXT NOT NULL DEFAULT '',
    publisher TEXT NOT NULL CHECK (btrim(publisher) <> ''),
    valid_from DATE NOT NULL,
    valid_to DATE CHECK (valid_to > valid_from),
    PRIMARY KEY (code, valid_from)
);
CREATE UNIQUE INDEX country_code_versions_current ON country_code_versions(code) WHERE valid_to IS NULL;
COMMENT ON TABLE country_codes IS 'Global ISO 3166-1 alpha-2 identities; retained after retirement for historical references';
COMMENT ON COLUMN country_codes.code IS 'pd:none — ISO country identity';
COMMENT ON TABLE country_code_versions IS 'Global dated ISO country catalog with Korean and English display labels';
COMMENT ON COLUMN country_code_versions.code IS 'pd:none — ISO country identity';
COMMENT ON COLUMN country_code_versions.label_ko IS 'pd:none — Korean display label (CLDR)';
COMMENT ON COLUMN country_code_versions.label_en IS 'pd:none — English display label (CLDR)';
COMMENT ON COLUMN country_code_versions.search_terms IS 'pd:none — alternate country search names and codes';
COMMENT ON COLUMN country_code_versions.publisher IS 'pd:none — code list publisher';
COMMENT ON COLUMN country_code_versions.valid_from IS 'pd:none — inclusive catalog validity start';
COMMENT ON COLUMN country_code_versions.valid_to IS 'pd:none — exclusive catalog validity end; NULL is open';
REVOKE ALL ON country_codes, country_code_versions FROM PUBLIC, console_rt;
GRANT SELECT ON country_codes, country_code_versions TO console_rt;

INSERT INTO country_code_versions(code, label_ko, label_en, publisher, valid_from)
SELECT code, label_ko, label_en, 'ISO 3166/MA', DATE '2026-11-12'
FROM (VALUES
    ('AD', '안도라', 'Andorra'),
    ('AE', '아랍에미리트', 'United Arab Emirates'),
    ('AF', '아프가니스탄', 'Afghanistan'),
    ('AG', '앤티가 바부다', 'Antigua & Barbuda'),
    ('AI', '앵귈라', 'Anguilla'),
    ('AL', '알바니아', 'Albania'),
    ('AM', '아르메니아', 'Armenia'),
    ('AO', '앙골라', 'Angola'),
    ('AQ', '남극 대륙', 'Antarctica'),
    ('AR', '아르헨티나', 'Argentina'),
    ('AS', '아메리칸 사모아', 'American Samoa'),
    ('AT', '오스트리아', 'Austria'),
    ('AU', '오스트레일리아', 'Australia'),
    ('AW', '아루바', 'Aruba'),
    ('AX', '올란드 제도', 'Åland Islands'),
    ('AZ', '아제르바이잔', 'Azerbaijan'),
    ('BA', '보스니아 헤르체고비나', 'Bosnia & Herzegovina'),
    ('BB', '바베이도스', 'Barbados'),
    ('BD', '방글라데시', 'Bangladesh'),
    ('BE', '벨기에', 'Belgium'),
    ('BF', '부르키나파소', 'Burkina Faso'),
    ('BG', '불가리아', 'Bulgaria'),
    ('BH', '바레인', 'Bahrain'),
    ('BI', '부룬디', 'Burundi'),
    ('BJ', '베냉', 'Benin'),
    ('BL', '생바르텔레미', 'St. Barthélemy'),
    ('BM', '버뮤다', 'Bermuda'),
    ('BN', '브루나이', 'Brunei'),
    ('BO', '볼리비아', 'Bolivia'),
    ('BQ', '네덜란드령 카리브', 'Caribbean Netherlands'),
    ('BR', '브라질', 'Brazil'),
    ('BS', '바하마', 'Bahamas'),
    ('BT', '부탄', 'Bhutan'),
    ('BV', '부베섬', 'Bouvet Island'),
    ('BW', '보츠와나', 'Botswana'),
    ('BY', '벨라루스', 'Belarus'),
    ('BZ', '벨리즈', 'Belize'),
    ('CA', '캐나다', 'Canada'),
    ('CC', '코코스 제도', 'Cocos (Keeling) Islands'),
    ('CD', '콩고-킨샤사', 'Congo - Kinshasa'),
    ('CF', '중앙 아프리카 공화국', 'Central African Republic'),
    ('CG', '콩고-브라자빌', 'Congo - Brazzaville'),
    ('CH', '스위스', 'Switzerland'),
    ('CI', '코트디부아르', 'Côte d’Ivoire'),
    ('CK', '쿡 제도', 'Cook Islands'),
    ('CL', '칠레', 'Chile'),
    ('CM', '카메룬', 'Cameroon'),
    ('CN', '중국', 'China'),
    ('CO', '콜롬비아', 'Colombia'),
    ('CR', '코스타리카', 'Costa Rica'),
    ('CU', '쿠바', 'Cuba'),
    ('CV', '카보베르데', 'Cape Verde'),
    ('CW', '퀴라소', 'Curaçao'),
    ('CX', '크리스마스섬', 'Christmas Island'),
    ('CY', '키프로스', 'Cyprus'),
    ('CZ', '체코', 'Czechia'),
    ('DE', '독일', 'Germany'),
    ('DJ', '지부티', 'Djibouti'),
    ('DK', '덴마크', 'Denmark'),
    ('DM', '도미니카', 'Dominica'),
    ('DO', '도미니카 공화국', 'Dominican Republic'),
    ('DZ', '알제리', 'Algeria'),
    ('EC', '에콰도르', 'Ecuador'),
    ('EE', '에스토니아', 'Estonia'),
    ('EG', '이집트', 'Egypt'),
    ('EH', '서사하라', 'Western Sahara'),
    ('ER', '에리트리아', 'Eritrea'),
    ('ES', '스페인', 'Spain'),
    ('ET', '에티오피아', 'Ethiopia'),
    ('FI', '핀란드', 'Finland'),
    ('FJ', '피지', 'Fiji'),
    ('FK', '포클랜드 제도', 'Falkland Islands'),
    ('FM', '미크로네시아', 'Micronesia'),
    ('FO', '페로 제도', 'Faroe Islands'),
    ('FR', '프랑스', 'France'),
    ('GA', '가봉', 'Gabon'),
    ('GB', '영국', 'United Kingdom'),
    ('GD', '그레나다', 'Grenada'),
    ('GE', '조지아', 'Georgia'),
    ('GF', '프랑스령 기아나', 'French Guiana'),
    ('GG', '건지', 'Guernsey'),
    ('GH', '가나', 'Ghana'),
    ('GI', '지브롤터', 'Gibraltar'),
    ('GL', '그린란드', 'Greenland'),
    ('GM', '감비아', 'Gambia'),
    ('GN', '기니', 'Guinea'),
    ('GP', '과들루프', 'Guadeloupe'),
    ('GQ', '적도 기니', 'Equatorial Guinea'),
    ('GR', '그리스', 'Greece'),
    ('GS', '사우스조지아 사우스샌드위치 제도', 'South Georgia & South Sandwich Islands'),
    ('GT', '과테말라', 'Guatemala'),
    ('GU', '괌', 'Guam'),
    ('GW', '기니비사우', 'Guinea-Bissau'),
    ('GY', '가이아나', 'Guyana'),
    ('HK', '홍콩(중국 특별행정구)', 'Hong Kong SAR China'),
    ('HM', '허드 맥도널드 제도', 'Heard & McDonald Islands'),
    ('HN', '온두라스', 'Honduras'),
    ('HR', '크로아티아', 'Croatia'),
    ('HT', '아이티', 'Haiti'),
    ('HU', '헝가리', 'Hungary'),
    ('ID', '인도네시아', 'Indonesia'),
    ('IE', '아일랜드', 'Ireland'),
    ('IL', '이스라엘', 'Israel'),
    ('IM', '맨섬', 'Isle of Man'),
    ('IN', '인도', 'India'),
    ('IO', '영국령 인도양 지역', 'British Indian Ocean Territory'),
    ('IQ', '이라크', 'Iraq'),
    ('IR', '이란', 'Iran'),
    ('IS', '아이슬란드', 'Iceland'),
    ('IT', '이탈리아', 'Italy'),
    ('JE', '저지', 'Jersey'),
    ('JM', '자메이카', 'Jamaica'),
    ('JO', '요르단', 'Jordan'),
    ('JP', '일본', 'Japan'),
    ('KE', '케냐', 'Kenya'),
    ('KG', '키르기스스탄', 'Kyrgyzstan'),
    ('KH', '캄보디아', 'Cambodia'),
    ('KI', '키리바시', 'Kiribati'),
    ('KM', '코모로', 'Comoros'),
    ('KN', '세인트키츠 네비스', 'St. Kitts & Nevis'),
    ('KP', '북한', 'North Korea'),
    ('KR', '대한민국', 'South Korea'),
    ('KW', '쿠웨이트', 'Kuwait'),
    ('KY', '케이맨 제도', 'Cayman Islands'),
    ('KZ', '카자흐스탄', 'Kazakhstan'),
    ('LA', '라오스', 'Laos'),
    ('LB', '레바논', 'Lebanon'),
    ('LC', '세인트루시아', 'St. Lucia'),
    ('LI', '리히텐슈타인', 'Liechtenstein'),
    ('LK', '스리랑카', 'Sri Lanka'),
    ('LR', '라이베리아', 'Liberia'),
    ('LS', '레소토', 'Lesotho'),
    ('LT', '리투아니아', 'Lithuania'),
    ('LU', '룩셈부르크', 'Luxembourg'),
    ('LV', '라트비아', 'Latvia'),
    ('LY', '리비아', 'Libya'),
    ('MA', '모로코', 'Morocco'),
    ('MC', '모나코', 'Monaco'),
    ('MD', '몰도바', 'Moldova'),
    ('ME', '몬테네그로', 'Montenegro'),
    ('MF', '생마르탱', 'St. Martin'),
    ('MG', '마다가스카르', 'Madagascar'),
    ('MH', '마셜 제도', 'Marshall Islands'),
    ('MK', '북마케도니아', 'North Macedonia'),
    ('ML', '말리', 'Mali'),
    ('MM', '미얀마', 'Myanmar (Burma)'),
    ('MN', '몽골', 'Mongolia'),
    ('MO', '마카오(중국 특별행정구)', 'Macao SAR China'),
    ('MP', '북마리아나제도', 'Northern Mariana Islands'),
    ('MQ', '마르티니크', 'Martinique'),
    ('MR', '모리타니', 'Mauritania'),
    ('MS', '몬트세라트', 'Montserrat'),
    ('MT', '몰타', 'Malta'),
    ('MU', '모리셔스', 'Mauritius'),
    ('MV', '몰디브', 'Maldives'),
    ('MW', '말라위', 'Malawi'),
    ('MX', '멕시코', 'Mexico'),
    ('MY', '말레이시아', 'Malaysia'),
    ('MZ', '모잠비크', 'Mozambique'),
    ('NA', '나미비아', 'Namibia'),
    ('NC', '뉴칼레도니아', 'New Caledonia'),
    ('NE', '니제르', 'Niger'),
    ('NF', '노퍽섬', 'Norfolk Island'),
    ('NG', '나이지리아', 'Nigeria'),
    ('NI', '니카라과', 'Nicaragua'),
    ('NL', '네덜란드', 'Netherlands'),
    ('NO', '노르웨이', 'Norway'),
    ('NP', '네팔', 'Nepal'),
    ('NR', '나우루', 'Nauru'),
    ('NU', '니우에', 'Niue'),
    ('NZ', '뉴질랜드', 'New Zealand'),
    ('OM', '오만', 'Oman'),
    ('PA', '파나마', 'Panama'),
    ('PE', '페루', 'Peru'),
    ('PF', '프랑스령 폴리네시아', 'French Polynesia'),
    ('PG', '파푸아뉴기니', 'Papua New Guinea'),
    ('PH', '필리핀', 'Philippines'),
    ('PK', '파키스탄', 'Pakistan'),
    ('PL', '폴란드', 'Poland'),
    ('PM', '생피에르 미클롱', 'St. Pierre & Miquelon'),
    ('PN', '핏케언 제도', 'Pitcairn Islands'),
    ('PR', '푸에르토리코', 'Puerto Rico'),
    ('PS', '팔레스타인 지구', 'Palestinian Territories'),
    ('PT', '포르투갈', 'Portugal'),
    ('PW', '팔라우', 'Palau'),
    ('PY', '파라과이', 'Paraguay'),
    ('QA', '카타르', 'Qatar'),
    ('RE', '레위니옹', 'Réunion'),
    ('RO', '루마니아', 'Romania'),
    ('RS', '세르비아', 'Serbia'),
    ('RU', '러시아', 'Russia'),
    ('RW', '르완다', 'Rwanda'),
    ('SA', '사우디아라비아', 'Saudi Arabia'),
    ('SB', '솔로몬 제도', 'Solomon Islands'),
    ('SC', '세이셸', 'Seychelles'),
    ('SD', '수단', 'Sudan'),
    ('SE', '스웨덴', 'Sweden'),
    ('SG', '싱가포르', 'Singapore'),
    ('SH', '세인트헬레나', 'St. Helena'),
    ('SI', '슬로베니아', 'Slovenia'),
    ('SJ', '스발바르제도-얀마웬섬', 'Svalbard & Jan Mayen'),
    ('SK', '슬로바키아', 'Slovakia'),
    ('SL', '시에라리온', 'Sierra Leone'),
    ('SM', '산마리노', 'San Marino'),
    ('SN', '세네갈', 'Senegal'),
    ('SO', '소말리아', 'Somalia'),
    ('SR', '수리남', 'Suriname'),
    ('SS', '남수단', 'South Sudan'),
    ('ST', '상투메 프린시페', 'São Tomé & Príncipe'),
    ('SV', '엘살바도르', 'El Salvador'),
    ('SX', '신트마르턴', 'Sint Maarten'),
    ('SY', '시리아', 'Syria'),
    ('SZ', '에스와티니', 'Eswatini'),
    ('TC', '터크스 케이커스 제도', 'Turks & Caicos Islands'),
    ('TD', '차드', 'Chad'),
    ('TF', '프랑스령 남방 지역', 'French Southern Territories'),
    ('TG', '토고', 'Togo'),
    ('TH', '태국', 'Thailand'),
    ('TJ', '타지키스탄', 'Tajikistan'),
    ('TK', '토켈라우', 'Tokelau'),
    ('TL', '동티모르', 'Timor-Leste'),
    ('TM', '투르크메니스탄', 'Turkmenistan'),
    ('TN', '튀니지', 'Tunisia'),
    ('TO', '통가', 'Tonga'),
    ('TR', '튀르키예', 'Türkiye'),
    ('TT', '트리니다드 토바고', 'Trinidad & Tobago'),
    ('TV', '투발루', 'Tuvalu'),
    ('TW', '대만', 'Taiwan'),
    ('TZ', '탄자니아', 'Tanzania'),
    ('UA', '우크라이나', 'Ukraine'),
    ('UG', '우간다', 'Uganda'),
    ('UM', '미국령 해외 제도', 'U.S. Outlying Islands'),
    ('US', '미국', 'United States'),
    ('UY', '우루과이', 'Uruguay'),
    ('UZ', '우즈베키스탄', 'Uzbekistan'),
    ('VA', '바티칸 시국', 'Vatican City'),
    ('VC', '세인트빈센트그레나딘', 'St. Vincent & Grenadines'),
    ('VE', '베네수엘라', 'Venezuela'),
    ('VG', '영국령 버진아일랜드', 'British Virgin Islands'),
    ('VI', '미국령 버진아일랜드', 'U.S. Virgin Islands'),
    ('VN', '베트남', 'Vietnam'),
    ('VU', '바누아투', 'Vanuatu'),
    ('WF', '왈리스-푸투나 제도', 'Wallis & Futuna'),
    ('WS', '사모아', 'Samoa'),
    ('YE', '예멘', 'Yemen'),
    ('YT', '마요트', 'Mayotte'),
    ('ZA', '남아프리카', 'South Africa'),
    ('ZM', '잠비아', 'Zambia'),
    ('ZW', '짐바브웨', 'Zimbabwe')
) AS labels(code, label_ko, label_en);

-- Common search forms belong to the reference catalog, alongside its display labels.
UPDATE country_code_versions SET search_terms = terms
FROM (VALUES ('KR', '한국'), ('US', 'USA'), ('GB', 'UK'), ('KP', '조선')) AS aliases(country, terms)
WHERE code = country;

INSERT INTO country_codes(code) SELECT DISTINCT code FROM country_code_versions;
ALTER TABLE country_code_versions ADD CONSTRAINT country_code_versions_code_fkey
    FOREIGN KEY (code) REFERENCES country_codes(code) ON DELETE RESTRICT;

-- NOT VALID preserves existing unknowns while enforcing every new nationality write.
ALTER TABLE employee_personal_facts ADD CONSTRAINT employee_personal_facts_nationality_fkey
    FOREIGN KEY (nationality) REFERENCES country_codes(code) ON DELETE RESTRICT NOT VALID;
DO $$
DECLARE
    invalid RECORD;
    tenant UUID;
    previous_org TEXT := current_setting('app.current_org', true);
BEGIN
    FOR tenant IN SELECT id FROM organizations LOOP
        PERFORM set_config('app.current_org', tenant::text, true);
        FOR invalid IN
            SELECT nationality, count(*) AS records FROM employee_personal_facts
            WHERE org_id = tenant AND nationality IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM country_codes c WHERE c.code = nationality)
            GROUP BY nationality ORDER BY nationality
        LOOP
            RAISE WARNING 'nationality_unknown: org_id=%, code=%, records=%; existing values retained', tenant, invalid.nationality, invalid.records;
        END LOOP;
    END LOOP;
    PERFORM set_config('app.current_org', coalesce(previous_org, ''), true);
END $$;
