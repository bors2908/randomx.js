const {mine} = require('../pkg-randomx.js-shared/dist/cjs/index')

const job = {
    "blob": "1010f7f2e4b70618f1fe647153b5a337098080ed8f90eee987ad4dd78bc0f3aa59bf3a53c991660000000081b6ec64f730565a0ac1dd619427aa884bf4cf8aeef7f901b00074d8390c075847",
    "job_id": "785297",
    "target": "ffff0000",
    "height": 3248070,
    "seed_hash": "3b0d5af1cdc3827e2f42f03e93661a252086f8d4e35dc65a9d3ea48e240cc795"
}

mine(job)
