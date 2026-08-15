const functions = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');

const RUNPOD_API_KEY = defineSecret('RUNPOD_API_KEY');
const MERCADO_PAGO_ACCESS_TOKEN = defineSecret('MERCADO_PAGO_ACCESS_TOKEN');

admin.initializeApp({
  projectId: 'falatexto-ae67d',
  storageBucket: 'falatexto-ae67d.firebasestorage.app'
});

const db = admin.firestore();
db.settings({ databaseId: 'falatexto-db' });

exports.mercadopagoWebhook = functions.https.onRequest(
  { secrets: [MERCADO_PAGO_ACCESS_TOKEN] },
  async (req, res) => {
    const t = new Date().toISOString();
    console.log(`[${t}] WEBHOOK:`, JSON.stringify(req.body));
    try {
      const tipo = req.body.type || req.query.topic;
      if (tipo !== 'payment') return res.send('OK');
      const paymentId = req.body.data?.id || req.query.id;
      if (!paymentId) return res.send('OK');
      const r = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN.value()}` }
      });
      const payment = r.data;
      if (payment.status === 'approved') {
        const uid = payment.external_reference;
        const valor = payment.transaction_amount;
        const creditos = Math.floor(valor);
        if (!uid) return res.send('OK');
        const ref = db.collection('usuarios').doc(uid);
        const doc = await ref.get();
        if (!doc.exists) await ref.set({ creditos: 0, email: 'pendente@email.com', createdAt: admin.firestore.Timestamp.now() });
        await ref.update({ creditos: admin.firestore.FieldValue.increment(creditos), ultimaRecarga: admin.firestore.Timestamp.now() });
        await db.collection('transacoes').add({ uid, paymentId, valor, creditos, data: admin.firestore.Timestamp.now(), status: 'approved' });
        console.log(`✅ +${creditos} créditos para ${uid}`);
      }
      res.send('OK');
    } catch (e) {
      console.error('ERRO webhook:', e.message);
      res.status(500).send('Erro');
    }
  }
);

exports.verificarSaldo = functions.https.onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Não autenticado');
  const mins = request.data?.minutos || 0;
  const doc = await db.collection('usuarios').doc(uid).get();
  if (!doc.exists) {
    await doc.ref.set({ creditos: 0, email: request.auth.token?.email || '', createdAt: admin.firestore.Timestamp.now() });
    return { saldo: 0, suficiente: false, faltam: mins };
  }
  const saldo = doc.data().creditos || 0;
  return { saldo, suficiente: saldo >= mins, faltam: Math.max(0, mins - saldo) };
});

exports.criarPagamento = functions.https.onCall(
  { secrets: [MERCADO_PAGO_ACCESS_TOKEN] },
  async (request) => {
    const uid = request.auth?.uid;
    console.log('💰 criarPagamento chamado por:', uid);
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Não autenticado');
    const valor = request.data?.valor;
    if (!valor || valor <= 0) throw new functions.https.HttpsError('invalid-argument', 'Valor inválido');
    const r = await axios.post('https://api.mercadopago.com/checkout/preferences', {
      items: [{ title: 'Créditos FalaTexto', quantity: 1, unit_price: valor, currency_id: 'BRL' }],
      external_reference: uid,
      back_urls: {
        success: 'https://falatexto-ae67d.web.app/app/?pagamento=ok',
        failure: 'https://falatexto-ae67d.web.app/app/?pagamento=erro',
        pending: 'https://falatexto-ae67d.web.app/app/?pagamento=pendente'
      },
      auto_return: 'approved'
    }, { headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN.value()}`, 'Content-Type': 'application/json' } });
    return { init_point: r.data.init_point };
  }
);

exports.criarPagamentoTeste = functions.https.onRequest(
  { secrets: [MERCADO_PAGO_ACCESS_TOKEN] },
  async (req, res) => {
    try {
      const valor = req.body.valor || 30;
      const r = await axios.post('https://api.mercadopago.com/checkout/preferences', {
        items: [{ title: 'Créditos FalaTexto (TESTE)', quantity: 1, unit_price: valor, currency_id: 'BRL' }],
        external_reference: 'hqUesQ7WmA0xiZQnQlod',
        back_urls: {
          success: 'https://falatexto-ae67d.web.app/app/?pagamento=ok',
          failure: 'https://falatexto-ae67d.web.app/app/?pagamento=erro',
          pending: 'https://falatexto-ae67d.web.app/app/?pagamento=pendente'
        },
        auto_return: 'approved'
      }, { headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN.value()}`, 'Content-Type': 'application/json' } });
      res.json({ init_point: r.data.init_point });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

exports.cancelarJob = functions.https.onCall(
  { secrets: [RUNPOD_API_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Usuário não autenticado');

    const jobId = request.data?.jobId;
    if (!jobId) throw new functions.https.HttpsError('invalid-argument', 'jobId é obrigatório');

    const RUNPOD_ENDPOINT_ID = 'd533697c8uwww0';
    const apiKey = RUNPOD_API_KEY.value();

    try {
      console.log(`🛑 Cancelando job ${jobId}...`);
      await axios.post(
        `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/cancel/${jobId}`,
        {},
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
      );
      await db.collection('jobs').doc(jobId).update({
        status: 'cancelado',
        statusMsg: 'Cancelado pelo usuário',
        canceladoEm: admin.firestore.Timestamp.now()
      });
      console.log(`✅ Job ${jobId} cancelado`);
      return { success: true };
    } catch (error) {
      console.error('❌ Erro ao cancelar job:', error.message);
      if (error.response?.status === 404) {
        await db.collection('jobs').doc(jobId).update({
          status: 'cancelado',
          statusMsg: 'Job não encontrado',
          canceladoEm: admin.firestore.Timestamp.now()
        });
        return { success: true };
      }
      throw new functions.https.HttpsError('internal', `Falha ao cancelar: ${error.message}`);
    }
  }
);

exports.processarAudio = functions.https.onCall(
  { secrets: [RUNPOD_API_KEY], timeoutSeconds: 540, memory: '256MiB' },
  async (request) => {
    const uid = request.auth?.uid;
    console.log('🎙️ processarAudio chamado por:', uid);
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Não autenticado');

    const filePath = request.data?.filePath;
    const fileName = request.data?.fileName;
    const minutos = request.data?.minutos;
    const numFalantes = request.data?.numFalantes || null;

    console.log(`Usuário: ${uid}, arquivo: ${filePath}, minutos: ${minutos}`);

    try {
      const usuarioRef = db.collection('usuarios').doc(uid);
      const usuarioDoc = await usuarioRef.get();
      const saldo = usuarioDoc.data()?.creditos || 0;
      if (saldo < minutos) throw new functions.https.HttpsError('failed-precondition', 'Créditos insuficientes');

      const bucket = admin.storage().bucket();
      const file = bucket.file(filePath);
      const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 3600000 });

      const apiKey = RUNPOD_API_KEY.value();
      const RUNPOD_ENDPOINT_ID = 'd533697c8uwww0';
      const runpodUrl = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`;
      console.log('🚀 Chamando RunPod:', runpodUrl);

      const runpodResp = await axios.post(
        runpodUrl,
        { input: { audio_url: url, num_falantes: numFalantes } },
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
      );

      const jobId = runpodResp.data.id;
      console.log('✅ Job RunPod:', jobId);

      await db.collection('jobs').doc(jobId).set({
        uid, jobId, filePath, nomeArquivo: fileName, minutos,
        status: 'processando', progresso: 0, etapa: 1,
        statusMsg: 'Transcrevendo áudio...',
        criadoEm: admin.firestore.Timestamp.now()
      });

      let status = 'IN_QUEUE';
      let result = null;
      let tentativas = 0;
      const maxTentativas = 100;

      while (['IN_QUEUE', 'IN_PROGRESS'].includes(status) && tentativas < maxTentativas) {
        await new Promise(r => setTimeout(r, 5000));

        const jobDoc = await db.collection('jobs').doc(jobId).get();
        if (jobDoc.exists && jobDoc.data().status === 'cancelado') {
          console.log(`🛑 Job ${jobId} cancelado pelo usuário`);
          throw new Error('Job cancelado pelo usuário');
        }

        const s = await axios.get(`https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${jobId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        status = s.data.status;
        tentativas++;

        const pct = Math.min(90, Math.round((tentativas / maxTentativas) * 90));
        const etapa = pct < 35 ? 1 : pct < 70 ? 2 : 3;
        await db.collection('jobs').doc(jobId).update({
          progresso: pct, etapa,
          statusMsg: etapa === 1 ? 'Transcrevendo áudio...' : etapa === 2 ? 'Alinhando timestamps...' : 'Corrigindo com IA...'
        });

        console.log(`Tentativa ${tentativas}: ${status}`);

        if (status === 'COMPLETED') {
          result = s.data.output;
          console.log('📦 Output RunPod:', JSON.stringify(result));
          if (!result) throw new Error('Worker retornou output vazio');
          if (result.status === 'error') throw new Error(`Worker retornou erro: ${result.message || 'sem detalhes'}`);
          if (!result.docx_base64) throw new Error(`docx_base64 ausente. Output: ${JSON.stringify(result)}`);
          break;
        }

        if (status === 'FAILED') {
          console.error('❌ RunPod FAILED:', JSON.stringify(s.data));
          throw new Error(`RunPod falhou: ${JSON.stringify(s.data.error || 'sem detalhes')}`);
        }
      }

      if (!result) {
        await db.collection('jobs').doc(jobId).update({ status: 'erro', statusMsg: 'Timeout' });
        throw new Error('Timeout: o processamento demorou mais que o esperado');
      }

      await usuarioRef.update({ creditos: admin.firestore.FieldValue.increment(-minutos) });

      const docxBuffer = Buffer.from(result.docx_base64, 'base64');
      const docxPath = filePath.replace(/\.[^.]+$/, '_transcrito.docx');
      const docxFile = bucket.file(docxPath);
      await docxFile.save(docxBuffer, { metadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
      await docxFile.makePublic();
      const docxUrl = `https://storage.googleapis.com/${bucket.name}/${docxPath}`;

      await db.collection('jobs').doc(jobId).update({
        status: 'concluido', progresso: 100, etapa: 3,
        statusMsg: 'Concluído!', docxUrl, docxPath,
        nomeArquivo: fileName, creditosUsados: minutos,
        concluidoEm: admin.firestore.Timestamp.now()
      });

      console.log('💾 DOCX:', docxUrl);
      return { sucesso: true, jobId, docxUrl };

    } catch (error) {
      console.error('❌ Erro:', error.message);
      throw new functions.https.HttpsError('internal', error.message);
    }
  }
);