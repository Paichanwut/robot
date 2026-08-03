-- =========================================================
-- solo-manga.com — MySQL/MariaDB schema
-- Modeled after a typical manga-aggregator site structure
-- (series -> chapters -> sequential page images, genres,
-- SEO description, cover art) plus articles/comments/ads.
--
-- Every column carries a COMMENT so the purpose is visible
-- directly in DBeaver/phpMyAdmin's table structure view,
-- not just in this file.
-- =========================================================

-- -----------------------------------------------------
-- MANGA CATALOG (synced from the bot after a chapter is
-- fully downloaded — never holds the bot's internal
-- scrape-state fields like retryCount/dedup hashes)
-- -----------------------------------------------------

CREATE TABLE series (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสเรื่อง (internal)',
  source_series_id  VARCHAR(64) UNIQUE COMMENT 'id ของเรื่องนี้ฝั่งบอท ใช้กัน sync ซ้ำ ไม่ใช่ FK ข้ามฐาน',
  slug              VARCHAR(255) NOT NULL UNIQUE COMMENT 'ใช้ทำ URL เช่น /manga/<slug>',
  title             VARCHAR(255) NOT NULL COMMENT 'ชื่อเรื่องหลักที่แสดงหน้าเว็บ',
  alt_titles        JSON COMMENT 'ชื่ออื่น/ชื่อภาษาอื่น เก็บเป็น JSON array ใช้ค้นหา/SEO',
  description       TEXT COMMENT 'เรื่องย่อ/คำโปรย',
  author            VARCHAR(255) COMMENT 'ชื่อผู้แต่ง/นักวาด',
  status            ENUM('ongoing','completed','hiatus') NOT NULL DEFAULT 'ongoing' COMMENT 'ongoing=กำลังฉาย, completed=จบแล้ว, hiatus=พักการเขียน',
  type              VARCHAR(50) COMMENT 'ประเภทตามที่เว็บต้นทางระบุ เช่น Manhwa, Manhua, Manga, Novel',
  rating            DECIMAL(3,1) COMMENT 'คะแนนที่เว็บต้นทางให้ไว้ (เช่น 8.0 จาก 10) - อ้างอิงเท่านั้น',
  cover_image_key   VARCHAR(500) COMMENT 'R2 object key ของรูปปก (ไม่เก็บไฟล์รูปในตารางนี้)',
  view_count        BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'จำนวนครั้งที่หน้าเรื่องนี้ถูกเข้าชมบนเว็บเรา (นับเอง ไม่ใช่ของเว็บต้นทาง)',
  source_view_count BIGINT UNSIGNED COMMENT 'ยอดวิวที่เว็บต้นทางรายงานไว้ตอนดึงข้อมูลมา (อ้างอิงเท่านั้น คนละตัวกับ view_count ของเราเอง)',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่เพิ่มเรื่องนี้เข้าระบบ',
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'วันที่แก้ไขข้อมูลเรื่องล่าสุด'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='ข้อมูลหลักของแต่ละเรื่องมังงะ';

CREATE TABLE chapters (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสตอน (internal)',
  series_id         INT UNSIGNED NOT NULL COMMENT 'อ้างอิงถึง series.id ว่าตอนนี้เป็นของเรื่องไหน',
  source_chapter_id VARCHAR(64) COMMENT 'id ของตอนนี้ฝั่งบอท ใช้กัน sync ซ้ำ',
  slug              VARCHAR(300) NOT NULL UNIQUE COMMENT 'ใช้ทำ URL เช่น /manga/<slug> รูปแบบ <series-slug>-epNNNN ตามแบบ URL ของเว็บต้นทาง',
  number            DECIMAL(8,2) NOT NULL COMMENT 'เลขตอน รองรับทศนิยมสำหรับตอนพิเศษ เช่น 12.5',
  title             VARCHAR(255) COMMENT 'ชื่อตอน เช่น "ราชาแห่งโลก"',
  published_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่ตอนนี้ถูกเผยแพร่บนเว็บเรา',
  view_count        BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'จำนวนครั้งที่ตอนนี้ถูกเปิดอ่าน',
  UNIQUE KEY uniq_series_number (series_id, number),
  CONSTRAINT fk_chapters_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='แต่ละตอนของแต่ละเรื่อง';

CREATE TABLE chapter_pages (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสหน้า (internal)',
  chapter_id    INT UNSIGNED NOT NULL COMMENT 'อ้างอิงถึง chapters.id ว่าหน้านี้อยู่ในตอนไหน',
  page_number   INT UNSIGNED NOT NULL COMMENT 'ลำดับหน้าในตอนนั้น เริ่มนับจาก 1',
  image_key     VARCHAR(500) NOT NULL COMMENT 'R2 object key ของรูปหน้านี้ (ไม่เก็บไฟล์ในตาราง)',
  width         INT UNSIGNED COMMENT 'ความกว้างรูป (px) ใช้จัด layout ล่วงหน้าก่อนโหลดรูปจริง',
  height        INT UNSIGNED COMMENT 'ความสูงรูป (px) ใช้จัด layout ล่วงหน้าก่อนโหลดรูปจริง',
  UNIQUE KEY uniq_chapter_page (chapter_id, page_number),
  CONSTRAINT fk_pages_chapter FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='รูปแต่ละหน้าของแต่ละตอน เรียงตาม page_number';

-- -----------------------------------------------------
-- GENRE / TAG
-- -----------------------------------------------------

CREATE TABLE genres (
  id      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสหมวดหมู่ (internal)',
  slug    VARCHAR(100) NOT NULL UNIQUE COMMENT 'ใช้ทำ URL เช่น /genre/<slug> เป็นภาษาอังกฤษเสมอ (จาก href ของเว็บต้นทาง หรือ glossary ที่แปลไว้)',
  name    VARCHAR(100) NOT NULL COMMENT 'ชื่อหมวดหมู่ภาษาอังกฤษ (ชื่อหลัก) เช่น Action, Fantasy',
  name_th VARCHAR(100) COMMENT 'ชื่อภาษาไทยของหมวดหมู่นี้ ถ้าเว็บต้นทางแสดงเป็นไทย (ไม่บังคับ)'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='รายชื่อหมวดหมู่/แท็กทั้งหมด';

CREATE TABLE series_genres (
  series_id INT UNSIGNED NOT NULL COMMENT 'อ้างอิงถึง series.id',
  genre_id  INT UNSIGNED NOT NULL COMMENT 'อ้างอิงถึง genres.id',
  PRIMARY KEY (series_id, genre_id),
  CONSTRAINT fk_sg_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  CONSTRAINT fk_sg_genre  FOREIGN KEY (genre_id)  REFERENCES genres(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='ตารางเชื่อม many-to-many ระหว่างเรื่องกับหมวดหมู่ (1 เรื่องมีได้หลายหมวด)';

-- -----------------------------------------------------
-- ARTICLES
-- -----------------------------------------------------

CREATE TABLE admins (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสแอดมิน (internal)',
  username      VARCHAR(100) NOT NULL UNIQUE COMMENT 'ชื่อผู้ใช้สำหรับ login เข้าระบบจัดการ',
  password_hash VARCHAR(255) NOT NULL COMMENT 'รหัสผ่านที่ผ่านการ hash แล้วเท่านั้น (argon2/bcrypt) ห้ามเก็บ plaintext',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่สร้างบัญชีแอดมินนี้'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='บัญชีผู้ดูแล/คนเขียนบทความ ไม่ใช่ user ทั่วไปของเว็บ';

CREATE TABLE media (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสรูป (internal)',
  image_key     VARCHAR(500) NOT NULL COMMENT 'R2 object key ของรูปที่แอดมินอัปเอง',
  alt_text      VARCHAR(255) COMMENT 'คำอธิบายรูป สำหรับ accessibility/SEO',
  uploaded_by   INT UNSIGNED COMMENT 'อ้างอิงถึง admins.id ผู้อัปโหลดรูปนี้',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่อัปโหลดรูปนี้',
  CONSTRAINT fk_media_admin FOREIGN KEY (uploaded_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='รูปที่แอดมินอัปเองสำหรับบทความ (คนละชุดกับรูปมังงะที่บอทดึงอัตโนมัติ)';

CREATE TABLE articles (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสบทความ (internal)',
  slug            VARCHAR(255) NOT NULL UNIQUE COMMENT 'ใช้ทำ URL เช่น /article/<slug>',
  title           VARCHAR(255) NOT NULL COMMENT 'หัวข้อบทความ',
  body            LONGTEXT NOT NULL COMMENT 'เนื้อหาบทความ (markdown หรือ html)',
  excerpt         VARCHAR(500) COMMENT 'สรุปย่อ แสดงในหน้ารายการบทความ',
  cover_media_id  INT UNSIGNED COMMENT 'อ้างอิงถึง media.id เป็นรูปหน้าปกบทความ',
  series_id       INT UNSIGNED COMMENT 'อ้างอิงถึง series.id ถ้าบทความนี้เกี่ยวกับเรื่องใดเรื่องหนึ่ง (ไม่บังคับ)',
  author_id       INT UNSIGNED COMMENT 'อ้างอิงถึง admins.id ผู้เขียนบทความนี้',
  status          ENUM('draft','published') NOT NULL DEFAULT 'draft' COMMENT 'draft=ฉบับร่างยังไม่เผยแพร่, published=เผยแพร่แล้ว',
  published_at    DATETIME COMMENT 'วันที่กดเผยแพร่บทความนี้',
  view_count      BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'จำนวนครั้งที่บทความนี้ถูกเข้าชม',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่สร้างบทความนี้',
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'วันที่แก้ไขบทความล่าสุด',
  CONSTRAINT fk_articles_media  FOREIGN KEY (cover_media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_articles_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE SET NULL,
  CONSTRAINT fk_articles_admin  FOREIGN KEY (author_id) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_articles_status_published (status, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='บทความ/ข่าวสารบนเว็บ ผูกกับเรื่องมังงะได้แต่ไม่บังคับ';

-- -----------------------------------------------------
-- COMMENTS (ไม่ login, เก็บ IP ผู้โพสต์)
-- -----------------------------------------------------

CREATE TABLE comments (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสคอมเมนต์ (internal)',
  commentable_type  ENUM('article','chapter','series') NOT NULL COMMENT 'คอมเมนต์นี้ผูกกับเนื้อหาประเภทไหน',
  commentable_id    INT UNSIGNED NOT NULL COMMENT 'รหัสของเนื้อหานั้นๆ (id ของ article/chapter/series ตาม commentable_type) — เช็คความถูกต้องที่ชั้น application',
  parent_comment_id INT UNSIGNED COMMENT 'อ้างอิงถึง comments.id อื่น ถ้าเป็นการ reply ต่อคอมเมนต์นั้น (NULL = คอมเมนต์หลัก)',
  display_name      VARCHAR(100) NOT NULL DEFAULT 'Anonymous' COMMENT 'ชื่อที่ผู้โพสต์ตั้งเอง (ไม่ login จึงพิมพ์อะไรก็ได้)',
  body              TEXT NOT NULL COMMENT 'เนื้อหาคอมเมนต์',
  ip_hash           CHAR(64) NOT NULL COMMENT 'HMAC-SHA256(ip, server_secret) แบบ hex ใช้เช็ค rate-limit/สแปมโดยไม่ต้องรู้ IP จริง',
  status            ENUM('pending','approved','spam','deleted') NOT NULL DEFAULT 'pending' COMMENT 'pending=รอตรวจ, approved=อนุมัติแสดงผล, spam=สแปม, deleted=ถูกลบ',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่โพสต์คอมเมนต์นี้',
  CONSTRAINT fk_comments_parent FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  INDEX idx_comments_target (commentable_type, commentable_id, status),
  INDEX idx_comments_ip_hash_time (ip_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='คอมเมนต์ของผู้เข้าชม ไม่ต้อง login';

CREATE TABLE comment_ip_log (
  comment_id  INT UNSIGNED PRIMARY KEY COMMENT 'อ้างอิงถึง comments.id (1 คอมเมนต์ มี 1 แถวในตารางนี้)',
  ip_address  VARBINARY(16) NOT NULL COMMENT 'IP จริงของผู้โพสต์ เก็บแบบกะทัดรัดด้วย INET6_ATON() รองรับทั้ง IPv4/IPv6',
  user_agent  VARCHAR(500) COMMENT 'User-Agent ของเบราว์เซอร์ผู้โพสต์ ช่วยตรวจจับสแปม',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่บันทึก IP นี้',
  CONSTRAINT fk_iplog_comment FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='IP จริงของผู้คอมเมนต์ แยกออกจากตาราง comments เพื่อความปลอดภัย/ความเป็นส่วนตัว ควรตั้ง policy ลบทิ้งเป็นระยะ';

-- -----------------------------------------------------
-- ADS (แบนเนอร์รูปภาพ + ลิงก์)
-- -----------------------------------------------------

CREATE TABLE ads (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'รหัสโฆษณา (internal)',
  name              VARCHAR(255) NOT NULL COMMENT 'ชื่อภายในให้แอดมินดูรู้เรื่อง ไม่แสดงหน้าเว็บ',
  placement         ENUM('header','sidebar','in_article','reader_top','reader_bottom','footer') NOT NULL COMMENT 'ตำแหน่งที่จะแสดงโฆษณานี้บนหน้าเว็บ',
  image_key         VARCHAR(500) NOT NULL COMMENT 'R2 object key ของรูปแบนเนอร์',
  target_url        VARCHAR(1000) NOT NULL COMMENT 'ลิงก์ปลายทางเมื่อผู้ชมคลิกแบนเนอร์',
  weight            INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'น้ำหนักการสุ่มแสดง ใช้เมื่อตำแหน่งเดียวกันมีหลายโฆษณาพร้อมกัน ค่ายิ่งมากยิ่งถูกสุ่มบ่อย',
  status            ENUM('active','paused','ended') NOT NULL DEFAULT 'active' COMMENT 'active=กำลังแสดงผล, paused=พักชั่วคราว, ended=จบแคมเปญแล้ว',
  starts_at         DATETIME COMMENT 'วันที่เริ่มแสดงโฆษณานี้ (NULL = แสดงได้ทันที)',
  ends_at           DATETIME COMMENT 'วันที่หยุดแสดงโฆษณานี้ (NULL = ไม่มีกำหนด)',
  impression_count  BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'จำนวนครั้งที่โฆษณานี้ถูกแสดงผล (ตัวนับสรุป ไม่ log ทุกครั้งกันตารางบวม)',
  click_count       BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'จำนวนครั้งที่โฆษณานี้ถูกคลิก',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่สร้างโฆษณานี้',
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'วันที่แก้ไขโฆษณานี้ล่าสุด',
  INDEX idx_ads_placement_status (placement, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='แบนเนอร์โฆษณารูปภาพ + ลิงก์ แยกตามตำแหน่งแสดงผล';
