const { execSync } = require('child_process');
const path = require('path');

try {
    console.log('--- Environment Check ---');
    console.log('CWD:', process.cwd());
    const pythonPath = './venv/bin/python3';

    console.log('Python path:', pythonPath);

    // Check python version
    const version = execSync(`${pythonPath} --version`).toString().trim();
    console.log('Python version:', version);

    // Check sys.path
    const sysPath = execSync(`${pythonPath} -c "import sys; print(sys.path)"`).toString().trim();
    console.log('sys.path:', sysPath);

    // Check librosa import
    console.log('Attempting to import librosa...');
    execSync(`${pythonPath} -c "import librosa; print('Librosa imported successfully')"`);
    console.log('SUCCESS: Librosa imported.');
} catch (e) {
    console.error('ERROR:', e.message);
    if (e.stdout) console.log('stdout:', e.stdout.toString());
    if (e.stderr) console.log('stderr:', e.stderr.toString());
}
