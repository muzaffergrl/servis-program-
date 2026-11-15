# Sunucuya kurulum (Railway)

Program, internetten erişilebilen ve **HTTPS** olan bir sunucuda çalışmalı. Telefon bildirimi ve
şoför konumu HTTPS olmadan çalışmaz. Önerilen yer **Railway**:
- GitHub'a her yükleme yaptığımızda otomatik güncellenir, velilerin bir şey yapması gerekmez
- HTTPS'li adres kendiliğinden gelir (`xxx.up.railway.app`)
- Aylık yaklaşık 5 dolar (Hobby planı) bu boyuttaki bir iş için yeter

> Railway'in ekranları zamanla değişebilir; düğme adları biraz farklı olabilir.

## 1. Hesap aç
1. https://railway.com adresine gir, **GitHub ile giriş yap**.
2. Hobby planını seç (kart bilgisi ister).

## 2. Projeyi oluştur
1. **New Project → Deploy from GitHub repo** → `servis-program-` deposunu seç.
   (Railway'e depoya erişim izni vermen istenir.)
2. Servis oluşunca **Settings → Source** kısmından dalı (branch) seç:
   şimdilik `claude/epic-brown-g3pxhw`. İleride `main`'e birleştirirsek onu seçeriz.
3. Railway depodaki `Dockerfile`'ı kendisi bulur ve kurar.

## 3. Kalıcı disk ekle (çok önemli)
Diski eklemezsen her güncellemede **tüm öğrenci ve yoklama kayıtları silinir**.
1. Servise sağ tıkla (veya Ctrl+K) → **Add Volume** (Disk ekle).
2. Bağlama yolu (Mount path): `/data`

## 4. Ayarları gir
Servis → **Variables** sekmesi:

| Değişken | Değer |
|---|---|
| `ADMIN_USER` | kendi yönetici kullanıcı adın (ör. `patron`) |
| `ADMIN_PASSWORD` | **güçlü bir şifre** (en az 12 karakter) |
| `VAPID_SUBJECT` | `mailto:` + iletişim e-postan (bildirim servisleri ister) |

`DB_FILE` ve `PORT` ayarlarına gerek yok, kendiliğinden doğru gelir.

## 5. Adres al
**Settings → Networking → Generate Domain**. Sana `https://xxx.up.railway.app` gibi bir adres verir.
İleride kendi alan adını (ör. `servisim.com`) da buraya bağlayabiliriz.

## 6. Dene
1. `https://xxx.up.railway.app/login` → süper yönetici olarak gir.
2. **Firmalar** sekmesinden bir test firması ekle, o firmanın paneline geç.
3. Okul, servis ve bir öğrenci ekle (öğrencinin evi olarak kendi evini seç).
4. Öğrenciler sekmesinde **Veli linki**'ni kopyala, kendi telefonunda aç:
   - Android: "Telefonuma bildirim gelsin"e bas, izin ver.
   - iPhone: Safari'de **Paylaş → Ana Ekrana Ekle**, ana ekrandaki simgeden aç, sonra izin ver.
5. Canlı sekmesinden **Sabah simülasyonu**'nu başlat, telefonu kilitle ve bildirimlerin gelip gelmediğine bak.

## Güncellemeler
GitHub'a yeni kod yüklendiğinde Railway birkaç dakika içinde kendiliğinden yeni sürümü kurar.
Veliler bir sonraki açışta yeni hâli görür; linkler ve bildirim izinleri değişmez.

## Yedek
Railway → Volume → **Backups** kısmından düzenli yedek almayı aç. Tüm veriler `/data/servis.db`
dosyasındadır.
