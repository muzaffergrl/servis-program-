# Servis Takip

Okul servisinin **eve kaç dakikada geleceğini** ve **okula ne zaman varacağını** velilerin
telefondan takip edebildiği sistem.

## Ekranlar

| Ekran | Adres | Kim kullanır |
|---|---|---|
| Veli ekranı | `/v/<veli-linki>` | Veli: kalan dakika, harita, bindi/indi durumu, telefon bildirimi, "bugün gelmeyecek", 30 günlük geçmiş |
| Şoför ekranı | `/d/<şoför-linki>` | Şoför: tur başlat/bitir, yoklama (bindi / binmedi / indi), telefondan konum |
| Firma paneli | `/admin` | Servis firması: servis, öğrenci, okul, canlı harita, yoklama raporu, linkleri WhatsApp ile gönderme |
| Süper yönetici | `/admin` | Biz: firmaları ekleme, pasife alma, istediği firmanın paneline geçme |

Her veliye kendi çocuğuna özel tahmin edilemez bir link verilir. Uygulama indirmek gerekmez.
Link başkasına geçerse yönetimden "Linki yenile" ile eskisi iptal edilir.

## Çalıştırma

Node.js 22.13 veya üstü gerekir.

```bash
npm install
npm run demo        # demo verisi (1 okul, 2 servis, 10 öğrenci) ekler ve başlatır
```

`http://localhost:3000/login`:
- Firma girişi: `demo` / `demo123`
- Süper yönetici: `admin` / `ADMIN_PASSWORD`

Canlı sekmesinde "Sabah simülasyonu" ile sahte bir servis yürütülür (yoklamayı da simülatör yapar);
Öğrenciler sekmesinden "Aç" ile veli ekranını görebilirsiniz.

```bash
npm test            # internet gerektirmez
```

## Ayarlar (ortam değişkenleri)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | 3000 | |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / admin | Süper yönetici. **Canlıda mutlaka değiştirin** |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | otomatik | Telefon bildirimi anahtarları. Verilmezse ilk açılışta üretilip veritabanında saklanır |
| `VAPID_SUBJECT` | mailto:destek@example.com | Bildirim servislerine bildirilen iletişim adresi |
| `DB_FILE` | `data/servis.db` | SQLite dosyası |
| `ROUTING` | `osrm` | `osrm` (yol ağına göre) veya `simple` (kuş uçuşu × 1.35) |
| `OSRM_URL` | `https://router.project-osrm.org` | Ücretsiz demo sunucu; kalıcı kullanımda kendi OSRM sunucumuz önerilir |
| `TILE_URL` | OpenStreetMap | Harita görselleri |
| `STOP_DWELL_SEC` | 45 | Her durakta ortalama bekleme |
| `ARRIVE_RADIUS_M` | 60 | Durağa varıldı sayılma mesafesi |
| `SIM_SPEEDUP` | 8 | Simülatör hız çarpanı |
| `EXTERNAL_API_URL` / `EXTERNAL_API_KEY` / `EXTERNAL_POLL_SEC` | – | Mevcut takip programının API'si |

## Süre nasıl hesaplanıyor?

1. Tur başlarken servisin konumundan başlayıp sıradaki tüm evlerden (ve sabah okuldan) geçen
   rota **bir kez** OSRM'den alınır. OSRM'e ulaşılamazsa basit tahmine düşer.
2. Servisten gelen her konum bu rotanın üzerine izdüşürülür; her durak için kalan süre
   = rotadaki kalan yol süresi + önündeki öğrenci sayısı × durak bekleme süresi.
3. Servis bir eve 60 m yaklaşınca o durak tamamlanır, veliye bildirim gider.
4. Servis rotadan 250 m'den fazla saparsa kalan duraklar için rota yeniden hesaplanır.
5. "Bugün gelmeyecek" denirse o ev turdan çıkarılır, diğer velilerin süresi kısalır.

Harita servisine sürekli istek atılmadığı için ücretsiz servisler yeterli.

## Yoklama ve güvenlik

- **Sabah:** şoför her evde "Bindi" / "Binmedi" der → veliye anında bildirim. Okulda
  "Okula vardık – herkes indi" ile binen herkesin inişi kaydedilir.
- **Akşam:** okulda "Bindi" / "Binmedi" (veya "Kalan herkes bindi"). Okul çıkışı binmeyen
  öğrencinin velisine **acil bildirim** gider ve o eve uğranmaz. Her evde "İndi".
- **Çocuk unutma kontrolü:** binen ama inişi işaretlenmeyen öğrenci varsa tur bitirilemez
  (şoför "aracı kontrol ettim" diye onaylamadıkça) ve yeni tur başlatılamaz; firma panelinde
  kırmızı uyarı çıkar.
- Yanlış dokunuş "geri al" ile düzeltilir. Tüm kayıtlar `attendance` tablosunda saklanır.

## Telefon bildirimleri

Veli ekranında "Telefonuma bildirim gelsin" → telefon kilitliyken de bildirim gelir (web push).
- Android / bilgisayar: Chrome, Edge, Firefox doğrudan çalışır.
- iPhone (iOS 16.4+): önce Safari'de **Paylaş → Ana Ekrana Ekle**, sonra ana ekrandaki simgeden açıp izin verilir.
- **HTTPS zorunlu** (localhost hariç).
- Veli "servis kaç dk kala haber versin" süresini kendisi seçer (kapatabilir de).

## Konum kaynakları

- **Şoför telefonu** (`/d/...` sayfası): Tur boyunca sayfa açık kalmalı.
- **Mevcut takip programı**: `src/providers/external-api.js`. API belgeleri gelince
  `parseVehicles` cevap formatına göre uyarlanacak; yönetimde her servise
  "Takip programındaki araç no" girilecek.
- **Simülatör**: Demo ve test için.

## Gizlilik (KVKK)

- Veli yalnızca kendi çocuğunun evini, okulu ve servisi görür; diğer öğrencilerin adı,
  adresi ve servis rotası gösterilmez (sadece "sizden önce 2 öğrenci alınacak").
- Servisin konumu yalnızca tur sırasında gösterilir.
- Canlıya çıkmadan önce velilerden açık rıza metni alınmalı.

## Yapılacaklar

- [ ] Mevcut takip programının API'sini bağlamak
- [ ] Zamanla öğrenen süre tahmini ("servis genelde 07:42'de gelir")
- [ ] Ücret takibi, belge hatırlatma, toplu duyuru
- [ ] Kardeşleri tek linkte gösterme, günlere göre farklı adres
- [ ] Trafik verisi (ücretli harita servisi) gerekirse
- [ ] Sunucuya kurulum (HTTPS zorunlu: tarayıcı konum ve bildirim izni için)
