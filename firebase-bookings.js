/*
 * Firestore persistence bridge for Rino Tattoo Studio.
 * Load this file AFTER firebase.initializeApp() and db = firebase.firestore().
 * Firestore collection: bookings
 */
(() => {
  'use strict';

  const BOOKINGS_KEY = 'rino_studio_bookings_v1';
  const collection = db.collection('bookings');
  const originalGetStorage = window.getStorage;
  const originalSetStorage = window.setStorage;
  let stopBookingsListener = null;
  let applyingRemoteSnapshot = false;

  function readLocalBookings() {
    return originalGetStorage(BOOKINGS_KEY, []);
  }

  function saveLocalBookings(bookings) {
    applyingRemoteSnapshot = true;
    originalSetStorage(BOOKINGS_KEY, bookings);
    applyingRemoteSnapshot = false;
  }

  function showPersistenceError(message) {
    if (typeof window.showToast === 'function') window.showToast(message, 'error');
    else console.error(message);
  }

  function toMap(items) {
    return new Map((Array.isArray(items) ? items : []).filter(item => item && item.id).map(item => [String(item.id), item]));
  }

  function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // Admin-side booking edits (status, payments, manual bookings, deletes) go to Firestore.
  window.setStorage = function(key, value) {
    if (key !== BOOKINGS_KEY || applyingRemoteSnapshot) {
      return originalSetStorage(key, value);
    }

    const before = readLocalBookings();
    originalSetStorage(key, value);
    const user = firebase.auth().currentUser;

    if (!user) {
      originalSetStorage(key, before);
      showPersistenceError('Inicia sesión con la cuenta autorizada de Firebase para modificar reservas.');
      return;
    }

    const oldItems = toMap(before);
    const newItems = toMap(value);
    const batch = db.batch();
    let writes = 0;

    newItems.forEach((booking, id) => {
      if (!oldItems.has(id) || !sameValue(oldItems.get(id), booking)) {
        batch.set(collection.doc(id), booking);
        writes++;
      }
    });
    oldItems.forEach((booking, id) => {
      if (!newItems.has(id)) {
        batch.delete(collection.doc(id));
        writes++;
      }
    });

    if (!writes) return;
    batch.commit().catch(error => {
      originalSetStorage(key, before);
      if (typeof window.refreshAllAdminData === 'function') window.refreshAllAdminData();
      console.error('Firestore booking write failed:', error);
      showPersistenceError('No se guardaron los cambios en Firebase. Revisa las reglas de Firestore y vuelve a intentarlo.');
    });
  };

  async function startAdminBookingsSync(user) {
    if (stopBookingsListener) stopBookingsListener();
    stopBookingsListener = null;
    if (!user) return;

    try {
      // Bring across older browser-only reservations once, but only when the cloud collection is empty.
      const existing = await collection.get();
      const local = readLocalBookings();
      if (existing.empty && local.length) {
        const migration = db.batch();
        local.forEach(booking => {
          if (booking && booking.id) migration.set(collection.doc(String(booking.id)), booking);
        });
        await migration.commit();
      }

      stopBookingsListener = collection.onSnapshot(snapshot => {
        const bookings = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
        saveLocalBookings(bookings);
        if (typeof window.refreshAllAdminData === 'function' && !document.getElementById('adminDashboardView')?.classList.contains('hidden')) {
          window.refreshAllAdminData();
        }
        if (typeof window.updateAvailableTimeSlots === 'function') window.updateAvailableTimeSlots();
      }, error => {
        console.error('Firestore bookings listener failed:', error);
        showPersistenceError('No se pudieron cargar las reservas de Firebase. Revisa las reglas de Firestore.');
      });
    } catch (error) {
      console.error('Firestore bookings initialization failed:', error);
      showPersistenceError('No se pudo sincronizar la agenda. Verifica Firestore y la sesión del tatuador.');
    }
  }

  firebase.auth().onAuthStateChanged(user => {
    startAdminBookingsSync(user);
  });

  // Intercept the public form so it reports success only after Firestore confirms the write.
  const bookingForm = document.getElementById('bookingForm');
  if (bookingForm) {
    bookingForm.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();

      const time = document.getElementById('bkTime').value;
      if (!time) {
        showPersistenceError('Selecciona una fecha y un horario disponible.');
        return;
      }

      const image = window.bookingRefImageBase64 || '';
      if (image.length > 700000) {
        showPersistenceError('La imagen de referencia es demasiado grande para guardar la reserva. Reduce su tamaño o envía la foto por WhatsApp.');
        return;
      }

      const id = 'BK-' + Date.now().toString().slice(-6) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      const booking = {
        id,
        name: document.getElementById('bkName').value.trim(),
        phone: document.getElementById('bkPhone').value.trim(),
        email: document.getElementById('bkEmail').value.trim(),
        style: document.getElementById('bkStyle').value,
        zone: document.getElementById('bkZone').value.trim(),
        size: document.getElementById('bkSize').value.trim(),
        isCoverup: document.getElementById('bkIsCoverup').checked,
        date: document.getElementById('bkDate').value,
        time,
        description: document.getElementById('bkDescription').value.trim(),
        refImage: image,
        status: 'Pendiente',
        totalPrice: 0,
        paidAmount: 0,
        paymentNote: 'Abono reserva $25.000 pendiente',
        createdAt: new Date().toLocaleDateString('es-CL')
      };

      const submitButton = bookingForm.querySelector('[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      try {
        // Re-check the selected slot in Firestore to reduce duplicate bookings from other devices.
        const sameSlot = await collection.where('date', '==', booking.date).where('time', '==', booking.time).get();
        if (sameSlot.docs.some(doc => doc.data().status !== 'Cancelada')) {
          if (typeof window.updateAvailableTimeSlots === 'function') window.updateAvailableTimeSlots();
          showPersistenceError('Ese horario acaba de ser reservado. Selecciona otro horario.');
          return;
        }

        await collection.doc(id).set(booking);
        const current = readLocalBookings();
        saveLocalBookings([booking, ...current.filter(item => item.id !== id)]);

        const waText = encodeURIComponent(
          `Hola Rino Tattoo Studio! Acabo de solicitar una reserva en la web:\n` +
          `• Código: ${id}\n• Nombre: ${booking.name}\n• Estilo: ${booking.style}${booking.isCoverup ? ' (Cobertura/Restauración)' : ''}\n` +
          `• Zona y Tamaño: ${booking.zone} (${booking.size})\n• Fecha y Hora: ${booking.date} a las ${booking.time} hrs\n• Idea: ${booking.description}`
        );
        document.getElementById('bookingSuccessSummary').innerHTML =
          `Código de solicitud: <strong class="text-gold">${id}</strong>.<br/>Hemos registrado tu solicitud para el <strong>${booking.date} a las ${booking.time} hrs</strong>. Envía tu resumen por WhatsApp para coordinar la evaluación y el abono de <strong>$25.000 CLP</strong>.`;
        document.getElementById('bookingWhatsappDirectLink').href = `https://wa.me/56937822387?text=${waText}`;
        bookingForm.classList.add('hidden');
        document.getElementById('bookingSuccessCard').classList.remove('hidden');
        if (typeof window.updateAvailableTimeSlots === 'function') window.updateAvailableTimeSlots();
        if (typeof window.showToast === 'function') window.showToast('Solicitud guardada en Firebase.');
      } catch (error) {
        console.error('Public booking save failed:', error);
        showPersistenceError('No se pudo guardar la reserva en Firebase. No cierres esta página; revisa la conexión y vuelve a enviar.');
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    }, true);
  }
})();
