<?php
session_start();
// Бір ғана құпия сөз - тек сіз білесіз
$correct_password = 'SIZDIN_QUpiya_soz123';

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['password'])) {
    if ($_POST['password'] === $correct_password) {
        $_SESSION['loggedin'] = true;
    } else {
        $error = 'Құпия сөз қате!';
    }
}

if (!isset($_SESSION['loggedin']) || $_SESSION['loggedin'] !== true) {
    // Кіру формасы
    echo '<!DOCTYPE html>
    <html><head><title>Жеке кіру</title></head><body>
    <h2>Жеке кабинетке кіру</h2>';
    if (isset($error)) echo '<p style="color:red">'.$error.'</p>';
    echo '<form method="post"><input type="password" name="password" placeholder="Құпия сөз" autofocus>
    <button type="submit">Кіру</button></form></body></html>';
    exit;
}

// Егер кірген болса - файл менеджері
?>
<!DOCTYPE html>
<html><head><title>Менің сейфім</title>
<style>body{font-family:Arial;padding:20px}</style>
</head><body>
<h1>📁 Жеке файлдар сейфі</h1>

<form action="upload.php" method="post" enctype="multipart/form-data">
    <input type="file" name="myfile" required>
    <button type="submit">Жүктеу</button>
</form>

<hr>
<h3>Сақталған файлдар:</h3>
<ul>
<?php
$files = scandir('uploads/');
foreach($files as $file) {
    if($file != '.' && $file != '..') {
        $size = round(filesize('uploads/'.$file)/1024, 1);
        echo "<li><a href='uploads/$file' target='_blank'>$file</a> ($size KB) 
              <a href='?delete=$file' onclick=\"return confirm('Жою керек?')\">[x]</a></li>";
    }
}
?>
</ul>
<p><a href="logout.php">Шығу</a></p>
</body></html>