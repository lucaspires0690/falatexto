// ===== CONFIGURAÇÕES =====
const STORAGE_BUCKET = 'fala-texto-ad013.appspot.com';
const RUNPOD_ENDPOINT = 'https://api.runpod.ai/v2/falatexto-worker/run';
const RUNPOD_API_KEY = ''; // não usado

// ===== ESTADO DO USUÁRIO =====
let currentUser = null;
let unsubscribeHistorico = null;

// ===== INICIALIZAÇÃO =====
firebase.auth().onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('userName').textContent = user.displayName || 'Usuário';
        document.getElementById('userEmail').textContent = user.email;
        
        // Carregar saldo
        await carregarSaldo();
        
        // Carregar histórico
        carregarHistorico();
        
        // Esconder exemplos
        document.querySelector('.historico-item.exemplo').style.display = 'none';
    } else {
        // Redirecionar para login se não estiver autenticado
        window.location.href = '/';
    }
});

// ===== CARREGAR SALDO =====
async function carregarSaldo() {
    try {
        const doc = await firebase.firestore()
            .collection('usuarios')
            .doc(currentUser.uid)
            .get();
        
        if (doc.exists) {
            document.getElementById('saldoCreditos').textContent = doc.data().creditos || 0;
        } else {
            // Criar documento se não existir
            await firebase.firestore()
                .collection('usuarios')
                .doc(currentUser.uid)
                .set({
                    creditos: 0,
                    email: currentUser.email,
                    nome: currentUser.displayName || '',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            document.getElementById('saldoCreditos').textContent = '0';
        }
    } catch (error) {
        console.error('Erro ao carregar saldo:', error);
        alert('Erro ao carregar saldo. Tente recarregar a página.');
    }
}

// ===== UPLOAD DE ARQUIVO =====
document.getElementById('fileInput').addEventListener('change', handleFileSelect);

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Validar tamanho (5GB = 5 * 1024 * 1024 * 1024)
    if (file.size > 5 * 1024 * 1024 * 1024) {
        alert('Arquivo muito grande. Máximo 5GB.');
        return;
    }
    
    // Validar duração (vamos calcular depois)
    const minutosEstimados = Math.ceil(file.size / (1024 * 1024)); // 1MB ~ 1 min (aproximado)
    
    // Verificar saldo
    const saldo = parseInt(document.getElementById('saldoCreditos').textContent);
    if (saldo < minutosEstimados) {
        alert(`Saldo insuficiente. Você precisa de ${minutosEstimados} créditos.`);
        return;
    }
    
    // Mostrar progresso
    document.getElementById('uploadBox').style.display = 'none';
    document.getElementById('uploadProgress').style.display = 'block';
    document.getElementById('progressStatus').textContent = 'Enviando arquivo...';
    
    try {
        // Upload para o Storage
        const storageRef = firebase.storage().ref();
        const fileRef = storageRef.child(`uploads/${currentUser.uid}/${Date.now()}_${file.name}`);
        
        const uploadTask = fileRef.put(file);
        
        uploadTask.on('state_changed', 
            (snapshot) => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                document.getElementById('progressFill').style.width = progress + '%';
                document.getElementById('progressFill').textContent = Math.round(progress) + '%';
            },
            (error) => {
                console.error('Erro no upload:', error);
                alert('Erro ao fazer upload. Tente novamente.');
                resetUpload();
            },
            async () => {
                // Upload concluído
                document.getElementById('progressStatus').textContent = 'Processando...';
                
                const downloadURL = await fileRef.getDownloadURL();
                const filePath = fileRef.fullPath;
                
                // Chamar Cloud Function para processar
                await processarAudio(filePath, minutosEstimados, downloadURL);
            }
        );
        
    } catch (error) {
        console.error('Erro:', error);
        alert('Erro ao processar arquivo.');
        resetUpload();
    }
}

// ===== PROCESSAR ÁUDIO (CHAMAR CLOUD FUNCTION) =====
async function processarAudio(filePath, minutos, downloadURL) {
    try {
        // Chamar a função do Firebase que vai integrar com RunPod
        const processarAudioFn = firebase.functions().httpsCallable('processarAudio');
        
        const result = await processarAudioFn({
            filePath: filePath,
            minutos: minutos,
            numFalantes: null // null = detectar automaticamente
        });
        
        if (result.data.sucesso) {
            document.getElementById('progressStatus').textContent = 'Processamento iniciado!';
            document.getElementById('uploadResult').style.display = 'block';
            
            // Atualizar saldo
            await carregarSaldo();
            
            // Recarregar histórico
            carregarHistorico();
            
            setTimeout(resetUpload, 3000);
        } else {
            throw new Error('Erro no processamento');
        }
        
    } catch (error) {
        console.error('Erro ao processar:', error);
        alert('Erro no processamento. Seus créditos não foram debitados.');
        resetUpload();
    }
}

// ===== RESETAR UPLOAD =====
function resetUpload() {
    document.getElementById('uploadBox').style.display = 'block';
    document.getElementById('uploadProgress').style.display = 'none';
    document.getElementById('uploadResult').style.display = 'none';
    document.getElementById('fileInput').value = '';
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressFill').textContent = '0%';
}

// ===== CARREGAR HISTÓRICO =====
function carregarHistorico() {
    if (unsubscribeHistorico) {
        unsubscribeHistorico();
    }
    
    const historicoLista = document.getElementById('historicoLista');
    const historicoVazio = document.getElementById('historicoVazio');
    
    unsubscribeHistorico = firebase.firestore()
        .collection('transcricoes')
        .where('usuarioId', '==', currentUser.uid)
        .orderBy('data', 'desc')
        .limit(20)
        .onSnapshot((snapshot) => {
            // Limpar lista (exceto o exemplo)
            document.querySelectorAll('.historico-item:not(.exemplo)').forEach(el => el.remove());
            
            if (snapshot.empty) {
                historicoVazio.style.display = 'block';
                return;
            }
            
            historicoVazio.style.display = 'none';
            
            snapshot.forEach(doc => {
                const data = doc.data();
                adicionarItemHistorico(data);
            });
        });
}

// ===== ADICIONAR ITEM AO HISTÓRICO =====
function adicionarItemHistorico(data) {
    const historicoLista = document.getElementById('historicoLista');
    
    const item = document.createElement('div');
    item.className = 'historico-item';
    
    const dataFormatada = data.data?.toDate?.() 
        ? data.data.toDate().toLocaleDateString('pt-BR') 
        : new Date().toLocaleDateString('pt-BR');
    
    item.innerHTML = `
        <div class="historico-info">
            <span class="historico-nome">${data.audioPath?.split('/').pop() || 'Arquivo'}</span>
            <span class="historico-data">${dataFormatada}</span>
            <span class="historico-status ${data.status || 'concluido'}">${data.status || 'Concluído'}</span>
        </div>
        <div class="historico-acoes">
            ${data.docxUrl 
                ? `<button class="btn-baixar" onclick="window.open('${data.docxUrl}')">⬇️ Baixar DOCX</button>` 
                : '<button class="btn-baixar" disabled>⏳ Processando</button>'}
        </div>
    `;
    
    historicoLista.appendChild(item);
}

// ===== LOGOUT =====
function logout() {
    firebase.auth().signOut()
        .then(() => {
            window.location.href = '/';
        })
        .catch((error) => {
            console.error('Erro ao sair:', error);
        });
}