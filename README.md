# AI Video Fabrikasi — o'rnatish qo'llanmasi

> Kod bilishing shart emas. Faqat quyidagi qadamlarni ketma-ket bajarasan.
> Har qadamda qiynalsang — menga yozib yubor, birga hal qilamiz.

Kerak bo'ladigan 3 narsa: **2 ta API kalit**, **GitHub**, **Railway**. Hammasi bepul boshlanadi.

---

## QADAM 1 — API kalitlarni olish (2 ta)

### a) Anthropic kaliti (senariy yozish uchun)
1. https://console.anthropic.com ga kir, ro'yxatdan o't
2. Chapdagi menyudan **API Keys** → **Create Key**
3. Kalitni nusxa ol — `sk-ant-...` bilan boshlanadi. **Bir joyga saqlab qo'y.**

### b) fal.ai kaliti (video yasash uchun)
1. https://fal.ai ga kir, ro'yxatdan o't (boshida bepul kredit beradi)
2. Dashboard → **API Keys** → yangi kalit yarat
3. Kalitni nusxa ol — `fal_...` bilan boshlanadi. **Saqlab qo'y.**

> 💡 Ikkalasi ham pullik ishlaydi, lekin arzon: bitta 1-daqiqalik video taxminan **$1–3** turadi (senariy + 10 ta klip). Boshida test uchun bir necha dollar yetadi.

---

## QADAM 2 — GitHub'ga fayllarni yuklash

1. https://github.com ga kir (akkaunting bo'lmasa — och)
2. O'ng yuqorida **+** → **New repository**
3. Nom ber (masalan `video-fabrika`), **Private** qilib qo'y, **Create**
4. Ochilgan sahifada **"uploading an existing file"** havolasini bos
5. Shu papkadagi HAMMA fayl va papkani sudrab tashla:
   - `server.js`
   - `package.json`
   - `.gitignore`
   - `public/` papkasi (ichida `index.html`)
   - `README.md`
6. Pastda **Commit changes** ni bos

✅ Fayllar GitHub'da.

---

## QADAM 3 — Railway'ga joylash

1. https://railway.app ga kir (GitHub bilan kirsang oson)
2. **New Project** → **Deploy from GitHub repo**
3. Hozir yaratgan `video-fabrika` repozitoriyni tanla
4. Railway o'zi o'rnatib, ishga tushiradi (1-2 daqiqa kutasan)

---

## QADAM 4 — Kalitlarni Railway'ga qo'shish (eng muhimi!)

1. Railway'da loyihangni och → **Variables** bo'limi
2. **New Variable** bosib, 2 tasini qo'sh:

| Nom (Name) | Qiymat (Value) |
|------------|----------------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` (1a-qadamdagi kalit) |
| `FAL_KEY` | `fal_...` (1b-qadamdagi kalit) |

3. Saqlagach Railway avtomatik qayta ishga tushadi

---

## QADAM 5 — Ochib ishlatish

1. Railway'da **Settings** → **Networking** → **Generate Domain**
2. Bergan havolani och (masalan `video-fabrika-production.up.railway.app`)
3. **Tayyor!** Sayt ochiladi — g'oyani yozasan, video chiqadi 🎉

Ishlayotganini tekshirish: havola oxiriga `/health` qo'shib och — `"anthropic":true,"fal":true` ko'rsatsa, kalitlar joyida.

---

## Muammo bo'lsa

- **Sayt ochilmayapti / xato** → Railway'da **Deployments** → oxirgi log'ni ko'r. Menga skrinshot yubor.
- **"ANTHROPIC_API_KEY o'rnatilmagan"** → 4-qadamni qayta tekshir (nom aynan shunday yozilishi kerak).
- **Video xato beryapti** → fal.ai'da kredit qolganini tekshir.

---

## Modelni almashtirish (ixtiyoriy)

Arzonroq yoki sifatliroq video model xohlasang, Railway Variables'ga qo'sh:

| Nom | Qiymat | Natija |
|-----|--------|--------|
| `VIDEO_MODEL` | `fal-ai/ltx-2/text-to-video` | arzon (standart) |
| `VIDEO_MODEL` | `fal-ai/bytedance/seedance/v1/pro` | sifatliroq |
| `TEXT_MODEL` | `claude-haiku-4-5-20251001` | arzonroq senariy |

---

## Keyingi bosqichlar (birga qilamiz)

- 🔊 **Ovoz** — dialoglarni Aisha AI / ElevenLabs bilan gapirtirib videoga qo'shish
- 🎭 **Personaj bir xilligi 2.0** — referens rasm orqali barqaror personajlar
- 💬 **Chat-maslahatchi** — tayyor video bo'yicha "buni o'zgartir" deb gaplashish
