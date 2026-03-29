/* ============================================
   GAINZ TRAIN — MAIN JS
   ============================================ */

// ---- NAV SCROLL EFFECT ----
const nav = document.querySelector('.nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 60);
  });
}

// ---- MOBILE NAV ----
const navToggle = document.querySelector('.nav-toggle');
const navMobile = document.querySelector('.nav-mobile');
const navClose = document.querySelector('.nav-mobile-close');

if (navToggle && navMobile) {
  navToggle.addEventListener('click', () => navMobile.classList.add('open'));
  navClose?.addEventListener('click', () => navMobile.classList.remove('open'));
  navMobile.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => navMobile.classList.remove('open'));
  });
}

// ---- FAQ ACCORDION ----
document.querySelectorAll('.faq-question').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});

// ---- SCROLL ANIMATIONS ----
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

document.querySelectorAll('.fade-up').forEach(el => observer.observe(el));

// ---- MACRO CALCULATOR ----
const goalBtns = document.querySelectorAll('.goal-btn');
const tierCards = document.querySelectorAll('.tier-card');
const recText = document.getElementById('recText');

const recommendations = {
  'lose-fat':        'athlete',
  'build-muscle':    'elite',
  'stay-consistent': 'athlete'
};

const messages = {
  'lose-fat':
    'For fat loss, we recommend the <strong>Athlete Plan</strong> — consistent meals stop the overeating that kills cuts. Hit your protein, control your calories, stay on track.',
  'build-muscle':
    'For muscle gain, we recommend the <strong>Elite Plan</strong> — maximum protein volume across 14-16 meals fuels serious growth. More meals = more protein = more gains.',
  'stay-consistent':
    'For staying consistent, the <strong>Athlete Plan</strong> is your best bet — covers lunch + dinner five days a week, keeps you out of the drive-through, and fits most schedules.'
};

goalBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    goalBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const goal = btn.dataset.goal;
    const rec = recommendations[goal];

    tierCards.forEach(card => {
      card.classList.remove('recommended', 'dimmed');
      if (card.dataset.tier === rec) {
        card.classList.add('recommended');
      } else {
        card.classList.add('dimmed');
      }
    });

    if (recText) {
      recText.innerHTML = messages[goal];
      recText.classList.add('visible');
    }
  });
});

// ---- SMOOTH ANCHOR SCROLLING ----
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', e => {
    const target = document.querySelector(anchor.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});
