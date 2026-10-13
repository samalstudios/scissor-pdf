//! Minimal store-only zip writer. PDFs are already compressed, so deflating them again buys little.

#[derive(Default)]
pub struct ZipWriter {
    data: Vec<u8>,
    central: Vec<u8>,
    count: u16,
}

impl ZipWriter {
    pub fn add(&mut self, name: &str, content: &[u8]) {
        let crc = crc32fast::hash(content);
        let offset = self.data.len() as u32;
        let size = content.len() as u32;
        let name = name.as_bytes();
        // DOS date 1980-01-01, time 00:00. UTF-8 names (flag bit 11).
        let common = |buf: &mut Vec<u8>| {
            buf.extend(20u16.to_le_bytes()); // version needed
            buf.extend(0x0800u16.to_le_bytes()); // flags
            buf.extend(0u16.to_le_bytes()); // method: store
            buf.extend(0u16.to_le_bytes()); // time
            buf.extend(0x21u16.to_le_bytes()); // date
            buf.extend(crc.to_le_bytes());
            buf.extend(size.to_le_bytes());
            buf.extend(size.to_le_bytes());
            buf.extend((name.len() as u16).to_le_bytes());
            buf.extend(0u16.to_le_bytes()); // extra length
        };
        self.data.extend(0x04034b50u32.to_le_bytes());
        common(&mut self.data);
        self.data.extend(name);
        self.data.extend(content);

        self.central.extend(0x02014b50u32.to_le_bytes());
        self.central.extend(20u16.to_le_bytes()); // version made by
        common(&mut self.central);
        self.central.extend(0u16.to_le_bytes()); // comment length
        self.central.extend(0u16.to_le_bytes()); // disk number
        self.central.extend(0u16.to_le_bytes()); // internal attrs
        self.central.extend(0u32.to_le_bytes()); // external attrs
        self.central.extend(offset.to_le_bytes());
        self.central.extend(name);
        self.count += 1;
    }

    pub fn finish(mut self) -> Vec<u8> {
        let cd_offset = self.data.len() as u32;
        let cd_size = self.central.len() as u32;
        self.data.extend(&self.central);
        self.data.extend(0x06054b50u32.to_le_bytes());
        self.data.extend(0u16.to_le_bytes());
        self.data.extend(0u16.to_le_bytes());
        self.data.extend(self.count.to_le_bytes());
        self.data.extend(self.count.to_le_bytes());
        self.data.extend(cd_size.to_le_bytes());
        self.data.extend(cd_offset.to_le_bytes());
        self.data.extend(0u16.to_le_bytes());
        self.data
    }
}
